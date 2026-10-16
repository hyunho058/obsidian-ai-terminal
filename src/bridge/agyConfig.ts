import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findOnPath } from '../pty/python';
import { supportDir } from '../support/installScripts';
import { MCP_SERVER_NAME } from '../core/constants';
import { redact, type Logger } from '../util/log';
import { isExecutableFile, isPidAlive } from '../util/process';

/** Basename of the bundled shim; installed to `~/.config/obsidian-ai-terminal/mcp_shim.py` (R11.9). */
export const SHIM_SCRIPT = 'mcp_shim.py';
export const AGY_LOCK_FILE = 'agy-config.lock';
/** A lock whose file was not touched for this long is abandoned (holders touch it before every agy call). */
export const LOCK_STALE_MS = 30_000;
export const LOCK_WAIT_MS = 9_000;
export const LIST_TIMEOUT_MS = 8_000;
export const WRITE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 1_000;

/** One row of `agy mcp list`. `command` is the COMMAND/URL column: command and args joined by single spaces. */
export interface AgyListEntry {
  name: string;
  type: string;
  status: string;
  command: string;
}

// Terminal escape sequences (colors, titles) in agy's output — matching control characters is the point.
// eslint-disable-next-line no-control-regex -- the escape sequences are what this strips
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Parses `agy mcp list` (agy 1.3: a tabwriter table `NAME  TYPE  STATUS  COMMAND/URL`, or
 * `No MCP servers configured.`). Columns are cut at the header offsets (names may contain spaces); rows that do not
 * fit fall back to splitting on runs of 2+ spaces. Returns null for output it does not recognise.
 */
export function parseMcpList(stdout: string): AgyListEntry[] | null {
  const lines = stdout
    .replace(ANSI, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;
  if (lines.length === 1 && /^no mcp servers configured/i.test(lines[0].trim())) return [];
  const headerAt = lines.findIndex((l) => /^\s*NAME\s+TYPE\s+STATUS\s+COMMAND/.test(l));
  if (headerAt < 0) return null;
  const header = lines[headerAt];
  // Column offsets in code points (Go's tabwriter counts runes).
  const offset = (label: string): number => Array.from(header.slice(0, header.indexOf(label))).length;
  const [typeAt, statusAt, commandAt] = [offset('TYPE'), offset('STATUS'), offset('COMMAND')];
  const entries: AgyListEntry[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    const chars = Array.from(line);
    const cut = (from: number, to?: number): string => chars.slice(from, to).join('').trim();
    const byColumn: AgyListEntry = {
      name: cut(0, typeAt),
      type: cut(typeAt, statusAt),
      status: cut(statusAt, commandAt),
      command: cut(commandAt),
    };
    const aligned =
      byColumn.name !== '' &&
      /^\S+$/.test(byColumn.type) &&
      /^\S+$/.test(byColumn.status) &&
      [typeAt, statusAt, commandAt].every((at) => chars[at - 1] === ' ');
    if (aligned) {
      entries.push(byColumn);
      continue;
    }
    const m = /^(.+?)\s{2,}(\S+)\s{2,}(\S+)\s{2,}(.*)$/.exec(line.trim());
    if (m) entries.push({ name: m[1], type: m[2], status: m[3], command: m[4].trim() });
  }
  return entries;
}

/**
 * Python's isolated mode for the shim: no script folder / user site-packages on `sys.path`, `PYTHON*` variables ignored —
 * nothing next to the shim or in the user's Python setup can change what agy runs (deviation 19).
 */
export const PYTHON_ISOLATED_FLAG = '-I';

/** Arguments after `agy mcp add obsidian --`: `<python> -I <shim>`. */
export function shimCommand(python: string, shimPath: string): string[] {
  return [python, PYTHON_ISOLATED_FLAG, shimPath];
}

/** The COMMAND/URL text `agy mcp list` shows for our entry (command and args joined by single spaces). */
export function shimCommandLine(python: string, shimPath: string): string {
  return shimCommand(python, shimPath).join(' ');
}

/**
 * True if an entry named `obsidian` was created by this plugin: a stdio entry running some `mcp_shim.py`, either the
 * current `<python> -I <shim>` or the older `<python> <shim>` (which `ensureEntry` updates once to the current form).
 */
export function isShimEntry(entry: AgyListEntry): boolean {
  return entry.type === 'stdio' && (entry.command === SHIM_SCRIPT || entry.command.endsWith(`/${SHIM_SCRIPT}`));
}

// --- running agy --------------------------------------------------------------------------------------------------

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Spawn failure (ENOENT, EACCES …). */
  error?: string;
  timedOut: boolean;
}

export interface RunOptions {
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
}

export type AgyRunner = (file: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>;

/** Runs a command without a shell; SIGTERM on timeout (SIGKILL 1 s later). Never rejects. */
export const runCommand: AgyRunner = (file, args, opts) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', error: (err as Error).message, timedOut: false });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) into.push(chunk);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    let timedOut = false;
    let killTimer: number | undefined;
    const timer = window.setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = window.setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, opts.timeoutMs);
    let spawnError: string | undefined;
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.on('close', (code, signal) => {
      window.clearTimeout(timer);
      if (killTimer) window.clearTimeout(killTimer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error: spawnError,
        timedOut,
      });
    });
  });

function ok(r: RunResult): boolean {
  return r.code === 0 && !r.error && !r.timedOut;
}

/**
 * One short line describing a failed run, for the log: agy's first stderr line, redacted. Never stdout — `agy mcp list`
 * prints every server's command / URL, which may hold another server's secrets.
 */
export function describeRun(r: RunResult): string {
  if (r.error) return redact(r.error);
  if (r.timedOut) return 'timed out';
  const first = r.stderr.trim().split('\n', 1)[0] ?? '';
  return `exit ${r.code ?? r.signal}${first ? `: ${redact(first).slice(0, 200)}` : ''}`;
}

// --- lock -----------------------------------------------------------------------------------------------------------

interface LockInfo {
  pid: number;
  nonce: string;
  createdAt: number;
}

/**
 * Cross-process exclusive lock: the file is created with O_EXCL (mode 0600) and holds `{pid, nonce, createdAt}`.
 * A lock is stale when its file was not touched for `staleMs` or its pid is dead; a stale lock is moved aside and
 * deleted only if it is still the same file (inode), so a fresh lock taken meanwhile is never removed.
 */
export class FileLock {
  private readonly nonce = randomUUID();
  private held = false;

  constructor(
    readonly file: string,
    private readonly staleMs = LOCK_STALE_MS,
  ) {}

  get isHeld(): boolean {
    return this.held;
  }

  /** Resolves true once held, false if `waitMs` passed (or `cancelled()` became true) first. */
  async acquire(waitMs: number, cancelled: () => boolean = () => false): Promise<boolean> {
    if (this.held) return true;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o755 });
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (cancelled()) return false;
      if (this.tryCreate()) return true;
      if (this.breakIfStale()) continue;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => window.setTimeout(r, 75 + Math.floor(Math.random() * 75)));
    }
  }

  /** Refreshes the lock's mtime so long operations do not look abandoned. */
  touch(): void {
    if (!this.held) return;
    try {
      const now = new Date();
      fs.utimesSync(this.file, now, now);
    } catch {
      // gone — nothing to refresh
    }
  }

  /** Removes the lock file if it is still ours. Synchronous (safe during plugin unload). */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      const info = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<LockInfo>;
      if (info.nonce === this.nonce) fs.unlinkSync(this.file);
    } catch {
      // already gone or replaced
    }
  }

  private tryCreate(): boolean {
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    try {
      const info: LockInfo = { pid: process.pid, nonce: this.nonce, createdAt: Date.now() };
      fs.writeSync(fd, JSON.stringify(info));
    } finally {
      fs.closeSync(fd);
    }
    this.held = true;
    return true;
  }

  /** True if the lock file is gone or was stale and has been removed (caller retries at once). */
  private breakIfStale(): boolean {
    let stat: fs.Stats;
    let info: Partial<LockInfo> | null = null;
    try {
      stat = fs.statSync(this.file);
      try {
        info = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<LockInfo>;
      } catch {
        info = null; // being written right now, or garbage: judged by age only
      }
    } catch {
      return true;
    }
    const old = Date.now() - stat.mtimeMs > this.staleMs;
    const dead = typeof info?.pid === 'number' && info.pid !== process.pid && !isPidAlive(info.pid);
    if (!old && !dead) return false;
    const aside = `${this.file}.stale-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(this.file, aside);
    } catch {
      return true;
    }
    try {
      if (fs.statSync(aside).ino !== stat.ino) {
        // Moved a lock that was created after our check: put it back unless yet another one exists.
        try {
          fs.linkSync(aside, this.file);
        } catch {
          // a newer lock already exists; ours stays aside and is dropped
        }
      }
    } finally {
      fs.rmSync(aside, { force: true });
    }
    return true;
  }
}

// --- agy entry ------------------------------------------------------------------------------------------------------

export type EnsureOutcome =
  | { status: 'added' | 'updated' | 'unchanged' }
  /**
   * An `obsidian` entry exists that this plugin did not create; it is left alone. Its command / URL is deliberately not
   * kept (it may hold a secret), so it can never reach a Notice or a log line.
   */
  | { status: 'foreign' }
  | { status: 'skipped' | 'failed'; reason: string };

export type RemoveOutcome =
  | { status: 'removed' | 'absent' }
  | { status: 'foreign' }
  | { status: 'skipped' | 'failed'; reason: string };

export const AGY_NOT_FOUND = 'agy not found';

export interface AgyConfigOptions {
  /** The agy profile command from settings (`agy`, `~/bin/agy`, `/abs/agy`). */
  getCommand: () => string;
  /** Environment for agy (the D6 spawn environment; its PATH is searched for the command). */
  getEnv: () => Record<string, string>;
  run?: AgyRunner;
  /** Default `~/.config/obsidian-ai-terminal/agy-config.lock`. */
  lockPath?: string;
  lockStaleMs?: number;
  lockWaitMs?: number;
  listTimeoutMs?: number;
  writeTimeoutMs?: number;
  homeDir?: () => string;
  log?: Logger;
}

/**
 * Manages the global agy entry `obsidian` → `<python3> -I ~/.config/obsidian-ai-terminal/mcp_shim.py` (D28, R11.3–R11.5,
 * R11.8) through `agy mcp list / add / remove` only — the config file itself is never read or written here (it holds
 * other servers' secrets). Every operation runs under the cross-process lock file, one at a time per instance.
 */
export class AgyConfig {
  private readonly run: AgyRunner;
  private queue: Promise<unknown> = Promise.resolve();
  private current: FileLock | null = null;
  private disposed = false;

  constructor(private readonly opts: AgyConfigOptions) {
    this.run = opts.run ?? runCommand;
  }

  /** Absolute path of the agy executable, or null if it cannot be found. */
  resolveAgy(): string | null {
    const home = this.homeDir();
    const raw = this.opts.getCommand().trim() || 'agy';
    const cmd = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
    if (cmd.includes('/')) {
      const abs = path.resolve(cmd);
      return isExecutableFile(abs) ? abs : null;
    }
    return findOnPath(cmd, this.opts.getEnv().PATH ?? '')[0] ?? null;
  }

  /** Adds or updates the entry unless it already runs `<python> -I <shimPath>` (R11.4). Never rejects. */
  ensureEntry(python: string, shimPath: string): Promise<EnsureOutcome> {
    return this.enqueue(async (agy, step) => {
      const listed = await this.list(agy, step);
      if ('reason' in listed) return { status: 'failed', reason: listed.reason };
      const want = shimCommandLine(python, shimPath);
      const existing = listed.entries.find((e) => e.name === MCP_SERVER_NAME);
      if (existing && existing.type === 'stdio' && existing.command === want) return { status: 'unchanged' };
      if (existing && !isShimEntry(existing)) return { status: 'foreign' };
      const added = await step(['mcp', 'add', MCP_SERVER_NAME, '--', ...shimCommand(python, shimPath)], this.writeTimeout());
      if (!added) return { status: 'skipped', reason: 'plugin unloading' };
      if (!ok(added)) return { status: 'failed', reason: `agy mcp add: ${describeRun(added)}` };
      if (existing?.status === 'disabled') {
        // `agy mcp add` re-enables an entry; keep the user's choice.
        const disabled = await step(['mcp', 'disable', MCP_SERVER_NAME], this.writeTimeout());
        if (disabled && !ok(disabled)) this.opts.log?.warn(`agy mcp disable: ${describeRun(disabled)}`);
      }
      return { status: existing ? 'updated' : 'added' };
    });
  }

  /** Removes the entry if it is ours (R11.8). Never rejects. */
  removeEntry(): Promise<RemoveOutcome> {
    return this.enqueue(async (agy, step) => {
      const listed = await this.list(agy, step);
      if ('reason' in listed) return { status: 'failed', reason: listed.reason };
      const existing = listed.entries.find((e) => e.name === MCP_SERVER_NAME);
      if (!existing) return { status: 'absent' };
      if (!isShimEntry(existing)) return { status: 'foreign' };
      const removed = await step(['mcp', 'remove', MCP_SERVER_NAME], this.writeTimeout());
      if (!removed) return { status: 'skipped', reason: 'plugin unloading' };
      if (ok(removed)) return { status: 'removed' };
      if (/not found/i.test(removed.stderr)) return { status: 'absent' };
      return { status: 'failed', reason: `agy mcp remove: ${describeRun(removed)}` };
    });
  }

  /** Stops further steps and releases a held lock synchronously (plugin unload). A running agy call finishes. */
  dispose(): void {
    this.disposed = true;
    this.current?.release();
    this.current = null;
  }

  private async list(agy: string, step: Step): Promise<{ entries: AgyListEntry[] } | { reason: string }> {
    const r = await step(['mcp', 'list'], this.opts.listTimeoutMs ?? LIST_TIMEOUT_MS);
    if (!r) return { reason: 'plugin unloading' };
    if (!ok(r)) return { reason: `${path.basename(agy)} mcp list: ${describeRun(r)}` };
    const entries = parseMcpList(r.stdout);
    if (!entries) return { reason: 'unrecognised `agy mcp list` output' };
    return { entries };
  }

  private enqueue<T extends EnsureOutcome | RemoveOutcome>(op: (agy: string, step: Step) => Promise<T>): Promise<T> {
    const task = this.queue.then(() => this.locked(op));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async locked<T extends EnsureOutcome | RemoveOutcome>(op: (agy: string, step: Step) => Promise<T>): Promise<T> {
    if (this.disposed) return { status: 'skipped', reason: 'plugin unloading' } as T;
    const agy = this.resolveAgy();
    if (!agy) return { status: 'skipped', reason: AGY_NOT_FOUND } as T;
    const lock = new FileLock(this.opts.lockPath ?? path.join(supportDir(), AGY_LOCK_FILE), this.opts.lockStaleMs);
    try {
      if (!(await lock.acquire(this.opts.lockWaitMs ?? LOCK_WAIT_MS, () => this.disposed))) {
        return { status: 'skipped', reason: this.disposed ? 'plugin unloading' : 'another Obsidian window is updating the agy entry' } as T;
      }
    } catch (err) {
      return { status: 'failed', reason: `lock file: ${(err as Error).message}` } as T;
    }
    this.current = lock;
    const env = { ...this.opts.getEnv(), NO_COLOR: '1' };
    const cwd = this.homeDir();
    const step: Step = async (args, timeoutMs) => {
      if (this.disposed) return null;
      lock.touch();
      this.opts.log?.debug(`agy ${args.slice(0, 3).join(' ')}`);
      return this.run(agy, args, { env, cwd, timeoutMs });
    };
    try {
      return await op(agy, step);
    } catch (err) {
      return { status: 'failed', reason: (err as Error).message } as T;
    } finally {
      lock.release();
      if (this.current === lock) this.current = null;
    }
  }

  private writeTimeout(): number {
    return this.opts.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
  }

  private homeDir(): string {
    return this.opts.homeDir?.() ?? os.homedir();
  }
}

/** Runs one agy call under the held lock; null once the plugin is unloading. */
type Step = (args: string[], timeoutMs: number) => Promise<RunResult | null>;
