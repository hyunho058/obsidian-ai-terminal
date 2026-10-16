import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '../util/log';

export type ShellEnvStatus = 'pending' | 'captured' | 'fallback';

export const SHELL_ENV_TIMEOUT_MS = 5_000;
const LOCALE_PROBE_TIMEOUT_MS = 2_000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SHELL = '/bin/zsh';
export const DEFAULT_LANG = 'en_US.UTF-8';

/** Terminal identity of every spawned program (D6, R3.2). */
export const TERMINAL_ENV: Readonly<Record<string, string>> = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  TERM_PROGRAM: 'obsidian-ai-terminal',
};

/** Prepended to PATH when the login-shell capture fails (R3.3); `~` = home. */
export const FALLBACK_PATH_DIRS: readonly string[] = ['~/.local/bin', '/opt/homebrew/bin'];

/** Electron / Chromium internals (R3.2) — removed from every layer. */
const ELECTRON_VAR = /^(ELECTRON_|CHROME_)/;

/**
 * Variables Obsidian may have inherited from the terminal or tool it was launched from. Removed from
 * `process.env` (not from what the login shell sets) so programs see this terminal, not another one, and
 * a Claude Code started inside Obsidian is not mistaken for a nested session of the launching one.
 */
const INHERITED_ONLY_VAR =
  /^(TERM_PROGRAM_VERSION|TERM_SESSION_ID|TERM_FEATURES|TERMINFO|COLORFGBG|LC_TERMINAL|LC_TERMINAL_VERSION|ITERM_\w+|KITTY_\w+|WEZTERM_\w+|ALACRITTY_\w+|GHOSTTY_\w+|VSCODE_\w+|TMUX|TMUX_PANE|STY|WT_SESSION|WT_PROFILE_ID|TERMINAL_EMULATOR|INSIDE_EMACS|CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|EXECPATH|MESSAGING_\w+))$/;

/** Per-shell-process bookkeeping that must not be copied into another process. */
const SHELL_LOCAL_VAR = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);

export interface CommandResult {
  code: number | null;
  stdout: string;
}
/** Runs a helper command (`defaults`, `locale`); injectable for tests. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface ShellEnvOptions {
  /** Login shell; default `$SHELL` when it is an absolute executable, else `/bin/zsh`. */
  shell?: string;
  /** Default: `process.env`, read when capturing. */
  baseEnv?: Record<string, string | undefined>;
  homeDir?: string;
  timeoutMs?: number;
  run?: CommandRunner;
  log?: Logger;
}

/**
 * The spawn environment (D6): captures the login shell's environment once (`$SHELL -l -i -c`, no PTY,
 * stdin closed, 5 s timeout) and layers it:
 * `process.env` − Electron/inherited-terminal vars → captured shell env → TERM/COLORTERM/TERM_PROGRAM →
 * `LANG` (only if still unset) → per-spawn extras.
 */
export class ShellEnv {
  private _status: ShellEnvStatus = 'pending';
  private _failureReason: string | undefined;
  private captured: Record<string, string> | null = null;
  private lang: string = DEFAULT_LANG;
  private capturePromise: Promise<void> | undefined;
  private child: ChildProcess | undefined;
  private disposed = false;
  private readonly run: CommandRunner;

  constructor(private readonly opts: ShellEnvOptions = {}) {
    this.run = opts.run ?? runCommand;
  }

  get status(): ShellEnvStatus {
    return this._status;
  }

  /** Why the capture failed (status `fallback`). */
  get failureReason(): string | undefined {
    return this._failureReason;
  }

  /** PATH of the spawn environment. */
  get path(): string {
    return this.getSpawnEnv().PATH ?? '';
  }

  get shell(): string {
    return resolveShell(this.opts.shell ?? this.baseEnv().SHELL);
  }

  /** Captures once; later calls return the same promise. Never rejects. */
  capture(): Promise<void> {
    if (!this.capturePromise) this.capturePromise = this.doCapture();
    return this.capturePromise;
  }

  /** Resolves when the capture has finished (successfully or with the fallback). Starts it if needed. */
  whenReady(): Promise<void> {
    return this.capture();
  }

  /**
   * A fresh copy of the spawn environment with `extra` layered on top (`undefined` removes a variable).
   * Before the capture finishes this is the fallback environment.
   */
  getSpawnEnv(extra?: Record<string, string | undefined>): Record<string, string> {
    const env = buildSpawnEnv({
      base: this.baseEnv(),
      captured: this.captured,
      homeDir: this.homeDir(),
      lang: this.lang,
    });
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
    return env;
  }

  /** Kills an in-flight capture (plugin unload). */
  dispose(): void {
    this.disposed = true;
    killGroup(this.child);
    this.child = undefined;
  }

  private baseEnv(): Record<string, string | undefined> {
    return this.opts.baseEnv ?? process.env;
  }

  private homeDir(): string {
    return this.opts.homeDir ?? os.homedir();
  }

  private async doCapture(): Promise<void> {
    const [shellResult, lang] = await Promise.all([this.captureShell(), this.probeLang()]);
    this.lang = lang;
    if ('env' in shellResult) {
      this.captured = shellResult.env;
      this._status = 'captured';
      this.opts.log?.debug(`captured login-shell environment from ${this.shell} (${Object.keys(shellResult.env).length} variables)`);
    } else {
      this._failureReason = shellResult.error;
      this._status = 'fallback';
      this.opts.log?.warn(`login-shell environment capture failed (${shellResult.error}); using the fallback PATH`);
    }
  }

  private captureShell(): Promise<{ env: Record<string, string> } | { error: string }> {
    const shell = this.shell;
    const marker = `__AI_TERMINAL_ENV_${randomUUID().replace(/-/g, '')}__`;
    const script = `printf '%s' '${marker}'; command /usr/bin/env -0; printf '%s' '${marker}'`;
    const timeoutMs = this.opts.timeoutMs ?? SHELL_ENV_TIMEOUT_MS;
    return new Promise((resolve) => {
      if (this.disposed) {
        resolve({ error: 'plugin unloading' });
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(shell, ['-l', '-i', '-c', script], {
          cwd: this.homeDir(),
          env: stripEnv(this.baseEnv(), true),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true, // own process group, so a timeout can kill everything the rc files started
        });
      } catch (err) {
        resolve({ error: `could not start ${shell}: ${(err as Error).message}` });
        return;
      }
      this.child = child;
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (result: { env: Record<string, string> } | { error: string }): void => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        resolve(result);
      };
      const timer = window.setTimeout(() => {
        killGroup(child);
        finish({ error: `timed out after ${Math.round(timeoutMs / 100) / 10} s` });
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_CAPTURE_BYTES) chunks.push(chunk);
      });
      child.stderr?.resume();
      child.on('error', (err) => finish({ error: `could not start ${shell}: ${err.message}` }));
      child.on('close', (code, signal) => {
        const env = parseEnvBlock(Buffer.concat(chunks).toString('utf8'), marker);
        if (env) finish({ env });
        else finish({ error: `${shell} printed no environment (exit ${code ?? signal})` });
      });
    });
  }

  private async probeLang(): Promise<string> {
    const [appleLocale, locales] = await Promise.all([
      this.run('/usr/bin/defaults', ['read', '-g', 'AppleLocale']).catch(() => null),
      this.run('/usr/bin/locale', ['-a']).catch(() => null),
    ]);
    return pickLang(
      appleLocale?.code === 0 ? appleLocale.stdout.trim() : undefined,
      locales?.code === 0 ? locales.stdout.split('\n') : [],
    );
  }
}

/** `$SHELL` when it is an absolute path to an executable, else `/bin/zsh`. */
export function resolveShell(shell: string | undefined): string {
  if (shell && path.isAbsolute(shell)) {
    try {
      fs.accessSync(shell, fs.constants.X_OK);
      return shell;
    } catch {
      // fall through
    }
  }
  return DEFAULT_SHELL;
}

/** Drops undefined values and Electron/Chromium variables; with `inherited`, also launcher-terminal variables. */
export function stripEnv(env: Record<string, string | undefined>, inherited: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || ELECTRON_VAR.test(k)) continue;
    if (inherited && INHERITED_ONLY_VAR.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Parses `env -0` output between the first and last marker; null if the markers are missing. */
export function parseEnvBlock(stdout: string, marker: string): Record<string, string> | null {
  const start = stdout.indexOf(marker);
  const end = stdout.lastIndexOf(marker);
  if (start < 0 || end <= start) return null;
  const block = stdout.slice(start + marker.length, end);
  const env: Record<string, string> = {};
  for (const entry of block.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return Object.keys(env).length ? env : null;
}

/** `<AppleLocale>.UTF-8` when `locale -a` lists it (region overrides like `@rg=…` dropped), else `en_US.UTF-8`. */
export function pickLang(appleLocale: string | undefined, available: readonly string[]): string {
  const base = appleLocale?.split('@')[0]?.trim();
  if (!base || !/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,3})?$/.test(base)) return DEFAULT_LANG;
  const wanted = `${base}.utf8`.toLowerCase();
  const match = available.map((l) => l.trim()).find((l) => l.toLowerCase().replace('utf-8', 'utf8') === wanted);
  return match ?? DEFAULT_LANG;
}

/** Prepends `dirs` to a PATH string, dropping later duplicates. */
export function prependPath(current: string | undefined, dirs: readonly string[]): string {
  const parts = [...dirs, ...(current ?? '').split(':')].filter(Boolean);
  return [...new Set(parts)].join(':');
}

export interface SpawnEnvLayers {
  base: Record<string, string | undefined>;
  /** Captured login-shell environment, or null for the fallback (capture failed / not done yet). */
  captured: Record<string, string> | null;
  homeDir: string;
  lang: string;
}

/** Builds the layered spawn environment (D6). */
export function buildSpawnEnv(layers: SpawnEnvLayers): Record<string, string> {
  const env = stripEnv(layers.base, true);
  if (layers.captured) {
    for (const [k, v] of Object.entries(stripEnv(layers.captured, false))) env[k] = v;
  } else {
    const dirs = FALLBACK_PATH_DIRS.map((d) => (d.startsWith('~/') ? path.join(layers.homeDir, d.slice(2)) : d));
    env.PATH = prependPath(env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', dirs);
  }
  for (const k of SHELL_LOCAL_VAR) delete env[k];
  Object.assign(env, TERMINAL_ENV);
  if (!env.LANG) env.LANG = layers.lang;
  return env;
}

function killGroup(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: LOCALE_PROBE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: stdout ?? '' });
    });
  });
