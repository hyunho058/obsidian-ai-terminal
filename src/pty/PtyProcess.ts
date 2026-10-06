import { spawn, type ChildProcess } from 'child_process';
import type { Writable } from 'stream';
import { TypedEmitter } from '../core/events';
import type { Disposer } from '../core/types';
import type { Logger } from '../util/log';

/** File name of the bundled helper (copied flat into the plugin folder by the build). */
export const HELPER_FILE = 'pty_bridge.py';

/** Prefix of the helper's machine-readable stderr lines (one JSON object each). */
export const HELPER_EVENT_MARKER = '@@pty_bridge ';

/**
 * After `kill()`, the helper gets this long to finish its own shutdown (SIGHUP, ≤ 3 s grace, SIGKILL) before
 * Node kills the helper and the program's process group itself.
 */
export const HARD_KILL_AFTER_MS = 5_000;

/** After the helper exits, how long to wait for its stdout/stderr to finish before reporting the exit. */
const STDIO_SETTLE_MS = 500;
const STDERR_TAIL_LINES = 20;
const MAX_STDERR_LINE = 64 * 1024;
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR']);

export interface PtySpawnOptions {
  /** Absolute path of a Python ≥ 3.9 interpreter. */
  python: string;
  /** Absolute path of `pty_bridge.py`. */
  helperPath: string;
  command: string;
  args?: readonly string[];
  cwd: string;
  /** Complete environment of the program (undefined values are dropped). */
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  log?: Logger;
  /** Overrides `HARD_KILL_AFTER_MS` (tests). */
  hardKillAfterMs?: number;
}

/** Why `exec` of the command failed inside the helper. */
export interface PtyExecError {
  errno: number;
  /** e.g. `ENOENT`, `EACCES`. */
  code: string;
  message: string;
}

export interface PtyExit {
  /**
   * The program's exit code: 128+N when it was killed by signal N, 127 when the command was not found,
   * 126 when it could not be executed. `null` when the helper could not start or was itself killed.
   */
  exitCode: number | null;
  /** Signal that ended the helper process itself (hard-kill fallback or an external kill), else null. */
  signal: NodeJS.Signals | null;
  /** The command was not found (exec failed with ENOENT / ENOTDIR) — show the settings hint (R3.4). */
  notFound: boolean;
  /** The command as given to `spawnPty`. */
  command: string;
  /** Set when exec failed (not found, permission denied …). */
  execError?: PtyExecError;
  /** Set when the helper itself could not be started. */
  error?: Error;
  /** The reason given to `kill()`, if the session was stopped. */
  killReason?: string;
  /** Last non-event lines the helper wrote to stderr (diagnostics). */
  stderr?: string;
}

export interface PtyProcessEvents {
  /** Raw program output, unchanged (UTF-8 sequences may be split across chunks — feed xterm the bytes). */
  data: Uint8Array;
  exit: PtyExit;
}

/**
 * One program running in a pseudo-terminal through `pty_bridge.py` (D8). The helper owns shutdown: `kill()`
 * only closes its stdin; Node intervenes only if the helper is still alive after `hardKillAfterMs`.
 */
export class PtyProcess {
  readonly command: string;
  readonly args: readonly string[];
  /** Resolves with the exit info once the helper has exited and its output has been delivered. */
  readonly exited: Promise<PtyExit>;

  private readonly child: ChildProcess;
  private readonly control: Writable | null;
  private readonly emitter: TypedEmitter<PtyProcessEvents>;
  private readonly log: Logger | undefined;
  private readonly hardKillAfterMs: number;
  private resolveExited!: (exit: PtyExit) => void;
  private exitInfo: PtyExit | null = null;
  private helperExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private spawnError: Error | undefined;
  private execError: PtyExecError | undefined;
  private killReason: string | undefined;
  private hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private openStreams = 2;
  private stderrBuf = '';
  private readonly stderrTail: string[] = [];
  private _programPid: number | undefined;
  private _cols: number;
  private _rows: number;

  constructor(opts: PtySpawnOptions) {
    this.command = opts.command;
    this.args = [...(opts.args ?? [])];
    this.log = opts.log;
    this.hardKillAfterMs = opts.hardKillAfterMs ?? HARD_KILL_AFTER_MS;
    this._cols = clampSize(opts.cols, 80);
    this._rows = clampSize(opts.rows, 24);
    this.emitter = new TypedEmitter<PtyProcessEvents>((m, e) => this.log?.error(m, e));
    this.exited = new Promise((resolve) => (this.resolveExited = resolve));

    this.child = spawn(
      opts.python,
      ['-I', opts.helperPath, String(this._cols), String(this._rows), opts.command, ...this.args],
      { cwd: opts.cwd, env: cleanEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
    );
    this.control = (this.child.stdio[3] as Writable | null) ?? null;

    const ignore = (what: string) => (err: Error) => this.log?.debug(`${what}: ${err.message}`);
    this.child.stdin?.on('error', ignore('stdin'));
    this.control?.on('error', ignore('resize channel'));

    const stdout = this.child.stdout;
    const stderr = this.child.stderr;
    if (stdout) {
      stdout.on('data', (chunk: Buffer) => this.emitter.emit('data', chunk));
      stdout.once('close', () => this.streamClosed());
    } else this.openStreams--;
    if (stderr) {
      stderr.setEncoding('utf8');
      stderr.on('data', (text: string) => this.onStderr(text));
      stderr.once('close', () => this.streamClosed());
    } else this.openStreams--;

    this.child.once('exit', (code, signal) => {
      this.helperExit = { code, signal };
      this.settleTimer = setTimeout(() => this.finish(), STDIO_SETTLE_MS);
      this.maybeFinish();
    });
    this.child.on('error', (err) => {
      // A spawn failure (missing interpreter, bad cwd) leaves pid undefined and may never emit 'exit'.
      if (this.child.pid === undefined) {
        this.spawnError = err;
        this.finish();
      } else {
        this.log?.warn('pty helper error', err);
      }
    });
  }

  /** Pid of the helper process (undefined if it failed to start). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Pid of the program (session / process-group leader inside the PTY), once the helper reported it. */
  get programPid(): number | undefined {
    return this._programPid;
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  get hasExited(): boolean {
    return this.exitInfo !== null;
  }

  /** Subscribes to `data` or `exit`. An `exit` listener added after the exit is called on the next microtask. */
  on<K extends keyof PtyProcessEvents>(event: K, listener: (payload: PtyProcessEvents[K]) => void): Disposer {
    const dispose = this.emitter.on(event, listener);
    if (event === 'exit' && this.exitInfo) {
      const info = this.exitInfo;
      queueMicrotask(() => (listener as (p: PtyExit) => void)(info));
    }
    return dispose;
  }

  /** Sends input to the program (strings are UTF-8 encoded). Ignored once the session is stopping or over. */
  write(data: string | Uint8Array): void {
    const stdin = this.child.stdin;
    if (this.exitInfo || this.killReason !== undefined || !stdin || stdin.destroyed || stdin.writableEnded) return;
    stdin.write(data);
  }

  /**
   * Sets the PTY size. The program gets SIGWINCH — also for an unchanged size, which the helper turns into an
   * explicit SIGWINCH (a redraw request).
   */
  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    this._cols = clampSize(cols, this._cols);
    this._rows = clampSize(rows, this._rows);
    const control = this.control;
    if (this.exitInfo || !control || control.destroyed || control.writableEnded) return;
    control.write(`${this._cols},${this._rows}\n`);
  }

  /**
   * Stops the session: closes the helper's stdin so it runs its shutdown (SIGHUP to the program's process
   * groups, ≤ 3 s grace, SIGKILL). If the helper is still alive after the hard-kill delay, Node SIGKILLs the
   * program's process group and the helper. Idempotent.
   */
  kill(reason = 'stopped'): void {
    if (this.exitInfo || this.killReason !== undefined) return;
    this.killReason = reason;
    this.log?.debug(`stopping ${this.command} (pid ${this.child.pid ?? '?'}): ${reason}`);
    this.child.stdin?.end();
    this.hardKillTimer = setTimeout(() => this.hardKill(), this.hardKillAfterMs);
  }

  private hardKill(): void {
    if (this.exitInfo || this.helperExit) return;
    this.log?.warn(`pty helper for ${this.command} did not exit ${this.hardKillAfterMs} ms after stop — killing it`);
    if (this._programPid) {
      try {
        process.kill(-this._programPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    try {
      this.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  private onStderr(text: string): void {
    this.stderrBuf += text;
    let nl: number;
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      this.handleStderrLine(this.stderrBuf.slice(0, nl));
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
    }
    if (this.stderrBuf.length > MAX_STDERR_LINE) {
      this.handleStderrLine(this.stderrBuf);
      this.stderrBuf = '';
    }
  }

  private handleStderrLine(line: string): void {
    if (line.startsWith(HELPER_EVENT_MARKER)) {
      const event = parseHelperEvent(line.slice(HELPER_EVENT_MARKER.length));
      if (event?.event === 'started' && typeof event.pid === 'number') {
        this._programPid = event.pid;
        return;
      }
      if (event?.event === 'exec_failed') {
        this.execError = {
          errno: typeof event.errno === 'number' ? event.errno : 0,
          code: typeof event.code === 'string' ? event.code : 'UNKNOWN',
          message: typeof event.message === 'string' ? event.message : 'exec failed',
        };
        return;
      }
    }
    if (!line.trim()) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
    this.log?.warn(`pty helper: ${line}`);
  }

  private streamClosed(): void {
    this.openStreams--;
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (this.helperExit && this.openStreams <= 0) this.finish();
  }

  private finish(): void {
    if (this.exitInfo) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.hardKillTimer) clearTimeout(this.hardKillTimer);
    if (this.stderrBuf) {
      this.handleStderrLine(this.stderrBuf);
      this.stderrBuf = '';
    }
    const exit: PtyExit = {
      exitCode: this.helperExit?.code ?? null,
      signal: this.helperExit?.signal ?? null,
      notFound: !!this.execError && NOT_FOUND_CODES.has(this.execError.code),
      command: this.command,
    };
    if (this.execError) exit.execError = this.execError;
    if (this.spawnError) exit.error = this.spawnError;
    if (this.killReason !== undefined) exit.killReason = this.killReason;
    if (this.stderrTail.length) exit.stderr = this.stderrTail.join('\n');
    this.exitInfo = exit;
    this.emitter.emit('exit', exit);
    this.resolveExited(exit);
  }
}

/** Starts `command` in a new PTY through the Python helper (R2.1). */
export function spawnPty(opts: PtySpawnOptions): PtyProcess {
  return new PtyProcess(opts);
}

function clampSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(65535, Math.floor(value)));
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

function parseHelperEvent(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
