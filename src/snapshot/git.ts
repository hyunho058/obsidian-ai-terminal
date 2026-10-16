import { execFile, spawn, type ChildProcess } from 'child_process';
import { redact } from '../util/log';

/** The only git the plugin uses (D31). Without the Command Line Tools it is a stub that opens an install dialog. */
export const SYSTEM_GIT = '/usr/bin/git';
export const SNAPSHOT_AUTHOR_NAME = 'Obsidian AI Terminal';
export const SNAPSHOT_AUTHOR_EMAIL = 'noreply@localhost';
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Per-command config (R12.13): the user's git config is never read (`GIT_CONFIG_GLOBAL=/dev/null`, no system config)
 * and never written; these settings make every command independent of it anyway.
 */
export const SAFE_GIT_CONFIG: readonly string[] = [
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'core.hooksPath=/dev/null',
  'core.autocrlf=false',
  'core.precomposeunicode=true',
  'core.quotepath=false',
  'core.fsmonitor=false',
  // Keep automatic gc / maintenance inside the commit process, so it is covered by the "plugin git running" check.
  'gc.autoDetach=false',
  'maintenance.autoDetach=false',
  `user.name=${SNAPSHOT_AUTHOR_NAME}`,
  `user.email=${SNAPSHOT_AUTHOR_EMAIL}`,
];

export interface GitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

export interface GitRunOptions {
  cwd: string;
  /** Written to stdin, which is then closed. */
  input?: string | Buffer;
  /**
   * The command never takes repository locks (`GIT_OPTIONAL_LOCKS=0`; log, cat-file, ls-files …). Only commands that
   * may take `index.lock` count for the stale-lock rule (R12.11).
   */
  readOnly?: boolean;
  /** Store this command works on — its process is tracked under it. */
  store?: string;
}

export class GitSpawnError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GitSpawnError';
  }
}

interface Tracked {
  proc: ChildProcess;
  mayLock: boolean;
  done: Promise<void>;
}

// Shared by every plugin instance in this Obsidian window: a reloaded plugin must still see the git its previous
// instance started (git is never killed, so it may outlive the instance).
const REGISTRY_KEY = Symbol.for('obsidian-ai-terminal.snapshot-git');

function registry(): Map<string, Set<Tracked>> {
  const g = window as unknown as Record<symbol, Map<string, Set<Tracked>> | undefined>;
  let map = g[REGISTRY_KEY];
  if (!map) g[REGISTRY_KEY] = map = new Map();
  return map;
}

/** Number of plugin-started git processes that may hold locks in `store` and are still running. */
export function runningLockingGit(store: string): number {
  let n = 0;
  for (const t of registry().get(store) ?? []) if (t.mayLock) n++;
  return n;
}

/** Resolves when no plugin-started, lock-taking git process runs in `store`. */
export async function whenLockingGitIdle(store: string): Promise<void> {
  for (;;) {
    const busy = [...(registry().get(store) ?? [])].filter((t) => t.mayLock);
    if (busy.length === 0) return;
    await Promise.all(busy.map((t) => t.done));
  }
}

function track(store: string, proc: ChildProcess, mayLock: boolean): void {
  const map = registry();
  let set = map.get(store);
  if (!set) map.set(store, (set = new Set()));
  let resolve!: () => void;
  const entry: Tracked = { proc, mayLock, done: new Promise<void>((r) => (resolve = r)) };
  set.add(entry);
  const finish = (): void => {
    set?.delete(entry);
    if (set?.size === 0 && map.get(store) === set) map.delete(store);
    resolve();
  };
  proc.once('close', finish);
  proc.once('error', finish);
}

/** Environment for git: the plugin's environment without any `GIT_*` override, ignoring the user's git config. */
export function gitEnv(base: NodeJS.ProcessEnv, readOnly: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  if (readOnly) env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/** Runs git with the safe config. Never kills a process: a slow git simply finishes later. */
export class GitRunner {
  constructor(
    readonly gitPath: string = SYSTEM_GIT,
    private readonly baseEnv: () => NodeJS.ProcessEnv = () => process.env,
  ) {}

  run(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
    const fullArgs = [...SAFE_GIT_CONFIG.flatMap((c) => ['-c', c]), ...args];
    return new Promise<GitResult>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(this.gitPath, fullArgs, {
          cwd: opts.cwd,
          env: gitEnv(this.baseEnv(), !!opts.readOnly),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        reject(spawnError(err, this.gitPath));
        return;
      }
      if (opts.store) track(opts.store, proc, !opts.readOnly);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      proc.stdout?.on('data', (b: Buffer) => out.push(b));
      proc.stderr?.on('data', (b: Buffer) => err.push(b));
      proc.once('error', (e) => {
        if (settled) return;
        settled = true;
        reject(spawnError(e, this.gitPath));
      });
      proc.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
      });
      proc.stdin?.on('error', () => {});
      if (opts.input !== undefined) proc.stdin?.end(opts.input);
      else proc.stdin?.end();
    });
  }
}

function spawnError(err: unknown, gitPath: string): GitSpawnError {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOENT') return new GitSpawnError(`${gitPath} not found`, e.code);
  return new GitSpawnError(`could not run ${gitPath}: ${e?.message ?? String(err)}`, e?.code);
}

/** One readable line from a failed git command, e.g. `Unable to create '…/index.lock': File exists.` */
export function gitFailureReason(result: Pick<GitResult, 'code' | 'signal' | 'stderr'>): string {
  const lines = result.stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[lines.length - 1];
  const text = line
    ? line.replace(/^(fatal|error):\s*/i, '')
    : result.signal
      ? `git was terminated (${result.signal})`
      : `git exited with code ${result.code}`;
  return truncate(redact(text), 200);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export type GitAvailability = { ok: true; version: string } | { ok: false; reason: string };

/**
 * R12.16: is git usable? For `/usr/bin/git` the Command Line Tools are checked first (`xcode-select -p`), so the
 * "install the Command Line Tools" dialog is never triggered.
 */
export async function checkGit(gitPath: string = SYSTEM_GIT, baseEnv: NodeJS.ProcessEnv = process.env): Promise<GitAvailability> {
  const env = gitEnv(baseEnv, true);
  if (gitPath === SYSTEM_GIT) {
    const clt = await exec('/usr/bin/xcode-select', ['-p'], env);
    if (!clt.ok) return { ok: false, reason: 'the Command Line Tools are not installed (run "xcode-select --install" in Terminal)' };
  }
  const v = await exec(gitPath, ['--version'], env);
  if (!v.ok) return { ok: false, reason: `"${gitPath} --version" failed: ${v.error}` };
  const version = v.stdout.trim();
  if (!/^git version \d/.test(version)) return { ok: false, reason: `"${gitPath} --version" printed something unexpected` };
  return { ok: true, version };
}

/** Runs a quick probe; gives up waiting after 5 s (the process is left alone). */
function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: true; stdout: string } | { ok: false; error: string }): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve(r);
    };
    const timer = window.setTimeout(() => finish({ ok: false, error: `no answer within ${PROBE_TIMEOUT_MS / 1000} s` }), PROBE_TIMEOUT_MS);
    try {
      execFile(cmd, args, { env, encoding: 'utf8' }, (err, stdout) => {
        if (err) finish({ ok: false, error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : err.message.split('\n')[0] ?? 'error' });
        else finish({ ok: true, stdout });
      });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
