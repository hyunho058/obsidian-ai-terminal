import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCP_SERVER_NAME } from '../core/constants';
import { supportDir } from '../support/installScripts';
import type { Logger } from '../util/log';
import { AGY_LOCK_FILE, FileLock, LOCK_WAIT_MS } from './agyConfig';

const fsp = fs.promises;

/** agy permission rule for every tool of the `obsidian` server (`mcp(<server>/<tool>)`, wildcards allowed). */
export const AGY_ALLOW_RULE = `mcp(${MCP_SERVER_NAME}/*)`;

/** agy's settings file under the current HOME (agy 1.3): `~/.gemini/antigravity-cli/settings.json`. */
export function agySettingsPath(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

export type AllowRuleOutcome =
  | { status: 'added' | 'present' | 'removed' | 'absent' }
  /** `settingsProblem`: the file is not a JSON object, has an unexpected shape or is read-only — left untouched. */
  | { status: 'skipped'; reason: string; settingsProblem?: true }
  | { status: 'failed'; reason: string };

export interface AgyPermissionsOptions {
  homeDir?: () => string;
  /** Default `~/.config/obsidian-ai-terminal/agy-config.lock` — the lock of the agy entry, shared on purpose. */
  lockPath?: () => string;
  lockStaleMs?: number;
  lockWaitMs?: number;
  log?: Logger;
  /** Creates `file` (must not exist) holding `text` with permission bits `mode`. Seam for tests. */
  writeNewFile?: (file: string, text: string, mode: number) => Promise<void>;
}

type Settings = Record<string, unknown>;
type Edit = (current: Settings | null) => { outcome: AllowRuleOutcome; next?: Settings };

const MAX_ATTEMPTS = 3;
const UNLOADING: AllowRuleOutcome = { status: 'skipped', reason: 'plugin unloading' };

/**
 * Deviation 22 — keeps the allow rule `mcp(obsidian/*)` in `permissions.allow` of agy's settings file, so agy does not
 * block the bridge tools. Every other key, value and rule is kept (and their order); the file keeps its mode and is
 * replaced atomically. A file that is not JSON or has an unexpected shape is never touched. The file's contents are
 * never logged (it may hold other data). Runs under the agy entry's lock file, one operation at a time.
 */
export class AgyPermissions {
  private queue: Promise<unknown> = Promise.resolve();
  private current: FileLock | null = null;
  private disposed = false;

  constructor(private readonly opts: AgyPermissionsOptions = {}) {}

  get settingsPath(): string {
    return agySettingsPath(this.opts.homeDir?.() ?? os.homedir());
  }

  /** Adds the rule unless it is there; creates the file if missing. `cancelled` is checked again once the lock is held. Never rejects. */
  ensureAllowRule(cancelled: () => boolean = () => false): Promise<AllowRuleOutcome> {
    return this.enqueue(cancelled, (current) => {
      if (current === null) return { outcome: { status: 'added' }, next: { permissions: { allow: [AGY_ALLOW_RULE] } } };
      const found = allowList(current);
      if ('problem' in found) return { outcome: settingsProblem(found.problem) };
      if (found.allow.includes(AGY_ALLOW_RULE)) return { outcome: { status: 'present' } };
      return { outcome: { status: 'added' }, next: withAllow(current, found.permissions, [...found.allow, AGY_ALLOW_RULE]) };
    });
  }

  /** Removes exactly the rule (every copy of it); never deletes the file or another key. Never rejects. */
  removeAllowRule(): Promise<AllowRuleOutcome> {
    return this.enqueue(
      () => false,
      (current) => {
        if (current === null) return { outcome: { status: 'absent' } };
        const found = allowList(current);
        if ('problem' in found) return { outcome: settingsProblem(found.problem) };
        if (!found.allow.includes(AGY_ALLOW_RULE)) return { outcome: { status: 'absent' } };
        const allow = found.allow.filter((rule) => rule !== AGY_ALLOW_RULE);
        return { outcome: { status: 'removed' }, next: withAllow(current, found.permissions, allow) };
      },
    );
  }

  /** Stops further work and releases a held lock synchronously (plugin unload). */
  dispose(): void {
    this.disposed = true;
    this.current?.release();
    this.current = null;
  }

  private enqueue(cancelled: () => boolean, edit: Edit): Promise<AllowRuleOutcome> {
    if (this.disposed) return Promise.resolve(UNLOADING);
    const task = this.queue.then(() => this.locked(cancelled, edit));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async locked(cancelled: () => boolean, edit: Edit): Promise<AllowRuleOutcome> {
    if (this.disposed) return UNLOADING;
    if (cancelled()) return { status: 'skipped', reason: 'no longer needed' };
    const lock = new FileLock(this.opts.lockPath?.() ?? path.join(supportDir(), AGY_LOCK_FILE), this.opts.lockStaleMs);
    try {
      if (!(await lock.acquire(this.opts.lockWaitMs ?? LOCK_WAIT_MS, () => this.disposed || cancelled()))) {
        if (this.disposed) return UNLOADING;
        if (cancelled()) return { status: 'skipped', reason: 'no longer needed' };
        return { status: 'skipped', reason: 'another Obsidian window is updating the agy settings' };
      }
    } catch (err) {
      return { status: 'failed', reason: `lock file: ${fsReason(err)}` };
    }
    this.current = lock;
    try {
      if (cancelled()) return { status: 'skipped', reason: 'no longer needed' };
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const outcome = await this.attempt(edit, lock);
        if (outcome !== 'retry') return outcome;
      }
      return { status: 'failed', reason: 'the settings file kept changing while it was updated' };
    } catch (err) {
      return { status: 'failed', reason: fsReason(err) };
    } finally {
      lock.release();
      if (this.current === lock) this.current = null;
    }
  }

  /** One read → edit → write. 'retry' when the file changed (or appeared) between the read and the write. */
  private async attempt(edit: Edit, lock: FileLock): Promise<AllowRuleOutcome | 'retry'> {
    const link = this.settingsPath;
    // Write through a symlink (dotfile setups) instead of replacing the link with a file.
    const file = await fsp.realpath(link).catch(() => link);
    let raw: Buffer | null = null;
    let mode = 0o600;
    try {
      raw = await fsp.readFile(file);
      mode = (await fsp.stat(file)).mode & 0o777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    let current: Settings | null = null;
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        // The parser's message quotes the file's text — never pass it on.
        return settingsProblem('the file is not valid JSON');
      }
      if (!isPlainObject(parsed)) return settingsProblem('the file is not a JSON object');
      current = parsed;
    }
    const { outcome, next } = edit(current);
    if (!next) return outcome;
    if (raw !== null && !(await isWritable(file))) return settingsProblem('the file is read-only');
    if (this.disposed) return UNLOADING;

    const dir = path.dirname(file);
    if (raw === null) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}-${randomUUID()}.tmp`);
    const write = this.opts.writeNewFile ?? writeNewFile;
    try {
      lock.touch();
      await write(tmp, `${JSON.stringify(next, null, 2)}\n`, mode);
      if (this.disposed) return UNLOADING;
      if (raw === null) {
        // Create without replacing a file that appeared meanwhile.
        try {
          await fsp.link(tmp, file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'retry';
          throw err;
        }
      } else {
        const again = await fsp.readFile(file).catch(() => null);
        if (!again || !again.equals(raw)) return 'retry';
        await fsp.rename(tmp, file);
      }
      return outcome;
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

function allowList(settings: Settings): { permissions: Settings | undefined; allow: unknown[] } | { problem: string } {
  const permissions = settings.permissions;
  if (permissions === undefined) return { permissions: undefined, allow: [] };
  if (!isPlainObject(permissions)) return { problem: '"permissions" is not an object' };
  const allow = permissions.allow;
  if (allow === undefined) return { permissions, allow: [] };
  if (!Array.isArray(allow)) return { problem: '"permissions.allow" is not a list' };
  return { permissions, allow };
}

/** A copy with `permissions.allow` replaced; keys keep their places (new keys go last). */
function withAllow(settings: Settings, permissions: Settings | undefined, allow: unknown[]): Settings {
  return { ...settings, permissions: { ...(permissions ?? {}), allow } };
}

function settingsProblem(problem: string): AllowRuleOutcome {
  return { status: 'skipped', reason: `agy settings left unchanged: ${problem}`, settingsProblem: true };
}

function isPlainObject(value: unknown): value is Settings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function isWritable(file: string): Promise<boolean> {
  try {
    await fsp.access(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeNewFile(file: string, text: string, mode: number): Promise<void> {
  const handle = await fsp.open(file, 'wx', mode);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.chmod(mode); // the open mode is reduced by the umask
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Error code + syscall only (an fs message holds just a path, but keep the log line short). */
function fsReason(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e.code ? `${e.code}${e.syscall ? ` (${e.syscall})` : ''}` : String(e.message ?? e);
}
