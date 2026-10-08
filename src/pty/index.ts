import * as fs from 'fs';
import * as path from 'path';
import type { FeatureModule, PluginContext } from '../core';
import type { ShellEnvService } from '../env/index';
import { HELPER_FILE, spawnPty, type PtyProcess } from './PtyProcess';
import { PythonResolver, type PythonProbe } from './python';

export * from './messages';
export * from './PtyProcess';
export * from './python';

/** The `python` service (D7). */
export interface PythonService {
  /** Absolute path of a working Python ≥ 3.9 (cached). Rejects with `PythonNotFoundError` (R2.5 message). */
  resolve(): Promise<string>;
  /** The cached interpreter, if already resolved. */
  current(): string | undefined;
  invalidate(): void;
}

export interface PtyLaunchOptions {
  command: string;
  args?: readonly string[];
  /** Working directory (the vault root for every profile). */
  cwd: string;
  cols: number;
  rows: number;
  /** Layered over the `shellEnv` spawn environment (e.g. `SpawnPlan.env`); `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
}

/** The `pty` service: starts programs in a PTY through the bundled helper (D8). */
export interface PtyService {
  /** Absolute path of `pty_bridge.py` in the plugin folder. */
  readonly helperPath: string;
  /**
   * Resolves Python, then spawns the helper. Rejects with `PythonNotFoundError` (show `err.message` in the
   * panel), `PtyHelperMissingError` or `PtyCwdMissingError`; nothing is spawned in those cases. A missing
   * *command* is reported later through the `exit` event (`notFound`, see `formatSpawnFailure`).
   */
  spawn(opts: PtyLaunchOptions): Promise<PtyProcess>;
  /** Live (not yet exited) processes started through this service. */
  live(): PtyProcess[];
}

declare module '../core/services' {
  interface ServiceMap {
    python: PythonService;
    pty: PtyService;
  }
}

export class PtyHelperMissingError extends Error {
  constructor(readonly helperPath: string) {
    super(`The terminal helper is missing (${helperPath}) — reinstall the plugin`);
    this.name = 'PtyHelperMissingError';
  }
}

export class PtyCwdMissingError extends Error {
  constructor(readonly cwd: string) {
    super(`Working folder not found: ${cwd}`);
    this.name = 'PtyCwdMissingError';
  }
}

export interface PtyModuleOptions {
  /** Overrides the interpreter probe (tests). */
  probe?: PythonProbe;
  systemPython?: string;
  hardKillAfterMs?: number;
}

/**
 * T2 — PTY helper (`pty_bridge.py`, run from `ctx.pluginDir`) and process wrapper with the Python lookup
 * (D7, D8). Publishes `python` and `pty`; `ready` resolves Python after the shell environment is captured.
 */
export function createPtyModule(options: PtyModuleOptions = {}): FeatureModule {
  let resolver: PythonResolver | undefined;
  const processes = new Set<PtyProcess>();

  const shellEnvOf = (ctx: PluginContext): ShellEnvService | undefined => ctx.services.get('shellEnv');

  return {
    id: 'pty',
    label: 'the terminal helper',
    register(ctx) {
      const log = ctx.log.child('pty');
      const pythonResolver = new PythonResolver({
        getSettingsPath: () => ctx.settings.pythonPath,
        getSearchPath: () => shellEnvOf(ctx)?.path ?? process.env.PATH,
        probe: options.probe,
        systemPython: options.systemPython,
        log,
      });
      resolver = pythonResolver;
      ctx.onSettingsChange((s, prev) => {
        if (s.pythonPath !== prev.pythonPath) pythonResolver.invalidate();
      });
      ctx.services.provide('python', {
        resolve: () => pythonResolver.resolve(),
        current: () => pythonResolver.current(),
        invalidate: () => pythonResolver.invalidate(),
      });

      const helperPath = path.join(ctx.pluginDir, HELPER_FILE);
      ctx.services.provide('pty', {
        helperPath,
        live: () => [...processes],
        async spawn(opts) {
          const python = await pythonResolver.resolve();
          if (!fs.existsSync(helperPath)) throw new PtyHelperMissingError(helperPath);
          if (!isDirectory(opts.cwd)) throw new PtyCwdMissingError(opts.cwd);
          const shellEnv = shellEnvOf(ctx);
          const extra = { PWD: opts.cwd, ...opts.env };
          const env = shellEnv ? shellEnv.getSpawnEnv(extra) : { ...process.env, ...extra };
          const proc = spawnPty({
            python,
            helperPath,
            command: opts.command,
            args: opts.args,
            cwd: opts.cwd,
            env,
            cols: opts.cols,
            rows: opts.rows,
            log,
            hardKillAfterMs: options.hardKillAfterMs,
          });
          processes.add(proc);
          proc.on('exit', () => processes.delete(proc));
          return proc;
        },
      });
    },
    async ready(ctx) {
      if (!resolver) return;
      try {
        const shellEnv = await ctx.services.whenAvailable('shellEnv', 1_000);
        await shellEnv.whenReady();
      } catch {
        // no env module: resolve against process.env PATH
      }
      try {
        await resolver.resolve();
      } catch (err) {
        ctx.log.child('pty').warn((err as Error).message);
      }
    },
    unload() {
      // Safety net: T3 stops its sessions first; anything left gets the helper's shutdown (stdin EOF).
      for (const proc of processes) proc.kill('plugin unload');
      processes.clear();
    },
  };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
