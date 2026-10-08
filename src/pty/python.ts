import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '../util/log';
import { isExecutableFile } from '../util/process';

/** Shown in the panel when no usable interpreter exists (R2.5). */
export const PYTHON_NOT_FOUND_MESSAGE = 'Python 3 not found — install it or set the path in Settings';
export const MIN_PYTHON_VERSION: readonly [number, number] = [3, 9];
/** Command Line Tools Python (D7 last resort). Without the CLT it is a stub that opens an install dialog. */
export const SYSTEM_PYTHON = '/usr/bin/python3';
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_SOURCE = 'import sys, pty, termios, fcntl, select; print(sys.version_info[:2])';

export type PythonSource = 'settings' | 'path' | 'system';

export interface PythonAttempt {
  path: string;
  source: PythonSource;
  /** Why it was rejected. */
  reason: string;
}

export class PythonNotFoundError extends Error {
  constructor(readonly attempts: readonly PythonAttempt[]) {
    super(PYTHON_NOT_FOUND_MESSAGE);
    this.name = 'PythonNotFoundError';
  }
}

export type PythonProbeResult = { version: [number, number] } | { error: string };
/** Runs `<python> -I -c "…print(sys.version_info[:2])"` and reports the version (injectable for tests). */
export type PythonProbe = (python: string) => Promise<PythonProbeResult>;

export interface PythonResolverOptions {
  /** `settings.pythonPath` (read at resolve time); empty = automatic. */
  getSettingsPath: () => string;
  /** PATH of the spawn environment (the captured login-shell PATH). */
  getSearchPath: () => string | undefined;
  systemPython?: string;
  probe?: PythonProbe;
  homeDir?: () => string;
  log?: Logger;
}

/**
 * Finds a Python ≥ 3.9 in the D7 order: settings override → every `python3` on the resolved PATH (in order)
 * → `/usr/bin/python3`. Each candidate is validated by running it. A successful result is cached until
 * `invalidate()` (settings change) or until the cached file disappears.
 */
export class PythonResolver {
  private cached: string | undefined;
  private inflight: Promise<string> | undefined;
  private generation = 0;
  private readonly probe: PythonProbe;
  private readonly systemPython: string;
  private readonly homeDir: () => string;

  constructor(private readonly opts: PythonResolverOptions) {
    this.probe = opts.probe ?? probePython;
    this.systemPython = opts.systemPython ?? SYSTEM_PYTHON;
    this.homeDir = opts.homeDir ?? os.homedir;
  }

  /** Absolute path of a working Python 3 (≥ 3.9). Rejects with `PythonNotFoundError`. */
  resolve(): Promise<string> {
    if (this.cached && isExecutableFile(this.cached)) return Promise.resolve(this.cached);
    this.cached = undefined;
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const inflight: Promise<string> = this.search()
      .then((found) => {
        if (generation === this.generation) this.cached = found;
        return found;
      })
      .finally(() => {
        if (this.inflight === inflight) this.inflight = undefined;
      });
    this.inflight = inflight;
    return inflight;
  }

  /** The cached interpreter, if one has been resolved. */
  current(): string | undefined {
    return this.cached;
  }

  /** Forgets the cached result (e.g. `pythonPath` changed). */
  invalidate(): void {
    this.generation++;
    this.cached = undefined;
    this.inflight = undefined;
  }

  /** Candidates in lookup order, de-duplicated by real path. Non-existent ones are reported as attempts. */
  candidates(): { candidates: Array<{ path: string; source: PythonSource }>; missing: PythonAttempt[] } {
    const out: Array<{ path: string; source: PythonSource }> = [];
    const missing: PythonAttempt[] = [];
    const seen = new Set<string>();
    const add = (p: string, source: PythonSource): void => {
      const key = realpathOr(p);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ path: p, source });
    };
    const searchPath = this.opts.getSearchPath() ?? '';

    const configured = this.opts.getSettingsPath().trim();
    if (configured) {
      const expanded = expandHome(configured, this.homeDir());
      const resolved = expanded.includes('/') ? path.resolve(expanded) : findOnPath(expanded, searchPath)[0];
      if (resolved && isExecutableFile(resolved)) add(resolved, 'settings');
      else missing.push({ path: configured, source: 'settings', reason: 'not found or not executable' });
    }
    for (const p of findOnPath('python3', searchPath)) add(p, 'path');
    if (isExecutableFile(this.systemPython)) add(this.systemPython, 'system');
    else missing.push({ path: this.systemPython, source: 'system', reason: 'not found' });
    return { candidates: out, missing };
  }

  private async search(): Promise<string> {
    const { candidates, missing } = this.candidates();
    const attempts = [...missing];
    for (const c of candidates) {
      const result = await this.probe(c.path);
      if ('version' in result && compareVersion(result.version, MIN_PYTHON_VERSION) >= 0) {
        if (attempts.length) this.opts.log?.info(`using ${c.path} (${result.version.join('.')}); skipped: ${describe(attempts)}`);
        return c.path;
      }
      const reason = 'version' in result ? `Python ${result.version.join('.')} is older than ${MIN_PYTHON_VERSION.join('.')}` : result.error;
      attempts.push({ path: c.path, source: c.source, reason });
    }
    this.opts.log?.warn(`no usable Python 3: ${describe(attempts) || 'no candidates'}`);
    throw new PythonNotFoundError(attempts);
  }
}

/** Default probe: runs the interpreter once (never the CLT stub when the Command Line Tools are missing). */
export const probePython: PythonProbe = async (python) => {
  if (realpathOr(python) === SYSTEM_PYTHON && !(await commandLineToolsInstalled())) {
    return { error: 'Command Line Tools are not installed' };
  }
  return new Promise((resolve) => {
    execFile(python, ['-I', '-c', PROBE_SOURCE], { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve({ error: err.killed ? `timed out after ${PROBE_TIMEOUT_MS} ms` : `failed: ${err.message.split('\n')[0]}` });
        return;
      }
      const version = parseVersion(stdout);
      resolve(version ? { version } : { error: `unexpected output: ${stdout.trim().slice(0, 80)}` });
    });
  });
};

function commandLineToolsInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xcode-select', ['-p'], { timeout: PROBE_TIMEOUT_MS }, (err) => resolve(!err));
  });
}

/** Parses `(3, 14)` (the probe's output). */
export function parseVersion(text: string): [number, number] | null {
  const m = /\((\d+),\s*(\d+)\)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function compareVersion(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** Every executable `name` on `searchPath`, in PATH order. */
export function findOnPath(name: string, searchPath: string): string[] {
  const out: string[] = [];
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const full = path.join(dir, name);
    if (isExecutableFile(full) && !out.includes(full)) out.push(full);
  }
  return out;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

function describe(attempts: readonly PythonAttempt[]): string {
  return attempts.map((a) => `${a.path} (${a.source}): ${a.reason}`).join('; ');
}
