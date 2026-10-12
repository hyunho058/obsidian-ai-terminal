import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR_NAME } from '../core/constants';
import type { Logger } from '../util/log';
import { BUNDLED_SCRIPTS } from './bundledScripts';

/** `~/.config/obsidian-ai-terminal` (HOME from `os.homedir()`, so tests can override it). */
export function supportDir(): string {
  return path.join(os.homedir(), '.config', DATA_DIR_NAME);
}

/** Stable absolute path of an installed support script, e.g. `~/.config/obsidian-ai-terminal/mcp_shim.py`. */
export function supportScriptPath(name: string): string {
  assertScriptName(name);
  return path.join(supportDir(), name);
}

export type InstallStatus = 'installed' | 'updated' | 'unchanged' | 'missing' | 'failed';

export interface InstallResult {
  name: string;
  path: string;
  status: InstallStatus;
  error?: string;
}

/**
 * Copies `<pluginDir>/<name>` to `supportScriptPath(name)` for each name, writing only when the content
 * differs (atomic rename, mode 0644). A script missing from the plugin folder is reported as `missing`.
 */
export async function installSupportScripts(pluginDir: string, names: Iterable<string>): Promise<InstallResult[]> {
  const dir = supportDir();
  const results: InstallResult[] = [];
  let dirReady = false;
  for (const name of names) {
    const dest = supportScriptPath(name);
    let source: Buffer;
    try {
      source = await fs.readFile(path.join(pluginDir, name));
    } catch (err) {
      results.push({ name, path: dest, status: 'missing', error: errorMessage(err) });
      continue;
    }
    try {
      if (!dirReady) {
        await fs.mkdir(dir, { recursive: true, mode: 0o755 });
        dirReady = true;
      }
      results.push({ name, path: dest, status: await writeIfChanged(dest, source) });
    } catch (err) {
      results.push({ name, path: dest, status: 'failed', error: errorMessage(err) });
    }
  }
  return results;
}

/**
 * Writes the Python helpers bundled in main.js into the plugin folder, only where the content differs.
 * Obsidian installs just main.js, manifest.json and styles.css from a release, so this runs on every load before
 * anything reads `<pluginDir>/<name>`. Never rejects; failures are in the results.
 */
export async function writeBundledScripts(
  pluginDir: string,
  scripts: Readonly<Record<string, string>> = BUNDLED_SCRIPTS,
): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  try {
    await fs.mkdir(pluginDir, { recursive: true });
  } catch (err) {
    return Object.keys(scripts).map((name) => ({ name, path: path.join(pluginDir, name), status: 'failed', error: errorMessage(err) }));
  }
  for (const [name, content] of Object.entries(scripts)) {
    const dest = path.join(pluginDir, name);
    try {
      assertScriptName(name);
      results.push({ name, path: dest, status: await writeIfChanged(dest, Buffer.from(content, 'utf8')) });
    } catch (err) {
      results.push({ name, path: dest, status: 'failed', error: errorMessage(err) });
    }
  }
  return results;
}

/** Atomic write (temp file + rename, mode 0644), skipped when `dest` already holds `content`. */
async function writeIfChanged(dest: string, content: Buffer): Promise<'installed' | 'updated' | 'unchanged'> {
  const current = await fs.readFile(dest).catch(() => null);
  if (current && current.equals(content)) return 'unchanged';
  const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tmp, content, { mode: 0o644 });
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return current ? 'updated' : 'installed';
}

/**
 * Per-plugin-load list of support scripts to install. Modules call `register(name)` in their `register()`;
 * the runtime calls `install()` once all modules are registered (part of the ready gate).
 * Modules whose `ready()` needs the files on disk can `await whenInstalled()`.
 */
export class SupportScripts {
  private readonly names = new Set<string>();
  private installed: Promise<InstallResult[]> | null = null;
  private resolveInstalled!: (r: InstallResult[]) => void;
  private readonly installedSignal = new Promise<InstallResult[]>((r) => (this.resolveInstalled = r));

  constructor(
    private readonly pluginDir: string,
    private readonly log?: Logger,
  ) {}

  /** Adds a bundled script (basename of a `src/**\/*.py` file) and returns its stable path. */
  register(name: string): string {
    assertScriptName(name);
    this.names.add(name);
    return supportScriptPath(name);
  }

  path(name: string): string {
    return supportScriptPath(name);
  }

  registered(): string[] {
    return [...this.names];
  }

  /** Installs every registered script. Runs once; later calls return the first result. Never rejects. */
  install(): Promise<InstallResult[]> {
    if (!this.installed) {
      this.installed = installSupportScripts(this.pluginDir, this.names)
        .catch((err): InstallResult[] => {
          this.log?.error('support script install failed', err);
          return [];
        })
        .then((results) => {
          for (const r of results) {
            if (r.status === 'missing' || r.status === 'failed') this.log?.warn(`support script ${r.name}: ${r.status}`, r.error ?? '');
            else this.log?.debug(`support script ${r.name}: ${r.status}`);
          }
          this.resolveInstalled(results);
          return results;
        });
    }
    return this.installed;
  }

  /** Resolves after `install()` has finished. */
  whenInstalled(): Promise<InstallResult[]> {
    return this.installedSignal;
  }
}

function assertScriptName(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) throw new Error(`Invalid support script name: ${name}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
