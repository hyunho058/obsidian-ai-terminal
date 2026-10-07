import type { FeatureModule, PluginContext } from '../core';
import { notice, type Logger } from '../util/log';
import { createClaudeIdeContributor, type IdeEndpoint } from './claudeIdeContributor';
import { claudeGlobalConfigFile, createDiffToolHint } from './ideDiffHint';
import { IdeServer, type SelectionSource } from './ideServer';
import { IDE_NAME, cleanStaleLockFiles, ideLockDir, isPidAlive, removeLockFile, workspaceFoldersFor, writeLockFile } from './lockFile';

export { IDE_FLAG, SSE_PORT_ENV, createClaudeIdeContributor, type IdeEndpoint } from './claudeIdeContributor';
export { DIFF_TOOL_HINT, claudeGlobalConfigFile, createDiffToolHint, readClaudeDiffTool } from './ideDiffHint';
export { IDE_AUTH_HEADER, IDE_SERVER_NAME, IdeServer, selectionChangedParams, type SelectionChangedParams } from './ideServer';
export { IDE_NAME, cleanStaleLockFiles, ideLockDir, isPidAlive, removeLockFile, writeLockFile, type IdeLockContent } from './lockFile';

/** The `ide` service: the Claude Code IDE connection of this vault (D27a). */
export interface IdeService extends IdeEndpoint {
  /** WebSocket port while the connection is up (server listening and lock file written), else null. */
  readonly port: number | null;
  /** `~/.claude/ide/<port>.lock` while the connection is up, else null. */
  readonly lockFilePath: string | null;
  /** True while the server listens and the lock file exists. */
  isRunning(): boolean;
  /** Resolves once the connection is up; rejects if it is turned off, stopped or fails to start. */
  whenListening(): Promise<void>;
  /** Connected Claude Code sessions (handshake completed). */
  clientCount(): number;
}

declare module '../core/services' {
  interface ServiceMap {
    ide: IdeService;
  }
}

export interface IdeModuleOptions {
  /** Lock file folder (tests); default `~/.claude/ide`. */
  lockDir?: string;
  /** Fixed auth token (tests). */
  token?: string;
  /** Selection seeding delays after a client's handshake (tests). */
  seedDelaysMs?: readonly number[];
  /** Liveness check for stale-file cleanup (tests). */
  isPidAlive?: (pid: number) => boolean;
  /** `pid` written to the lock file; default `process.pid` (the Obsidian process that spawns the panels). */
  pid?: number;
  /** Where page-unload events come from (tests); default the plugin's `window`. */
  windowTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

/**
 * A window reload (Cmd+R) or quit may skip plugin unload; the renderer keeps its pid across a reload, so a lock file
 * left behind would look alive. These events remove it synchronously first.
 */
const PAGE_UNLOAD_EVENTS = ['pagehide', 'unload'] as const;

class CancelledError extends Error {
  constructor() {
    super('The Claude Code IDE connection was turned off while starting.');
    this.name = 'CancelledError';
  }
}

/** Server + lock file, started and stopped together. `disable()` / `dispose()` are synchronous (R10.9). */
export class IdeConnection implements IdeService {
  private generation = 0;
  private lockPath: string | null = null;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly server: IdeServer,
    private readonly cfg: { lockDir: string; vaultPath: string; pid: number; log: Logger },
  ) {}

  get port(): number | null {
    return this.lockPath ? this.server.port : null;
  }

  get lockFilePath(): string | null {
    return this.lockPath;
  }

  isRunning(): boolean {
    return this.lockPath !== null && this.server.isRunning();
  }

  clientCount(): number {
    return this.server.clientCount();
  }

  whenListening(): Promise<void> {
    if (this.isRunning()) return Promise.resolve();
    if (this.pending) return this.pending;
    return Promise.reject(new Error('The Claude Code IDE connection is not running (turned off in settings or stopped).'));
  }

  /** Starts the server, then writes the lock file. Rejects with `CancelledError` if `disable()` came first. */
  enable(): Promise<void> {
    if (this.isRunning()) return Promise.resolve();
    if (this.pending) return this.pending;
    const gen = ++this.generation;
    const run = async (): Promise<void> => {
      try {
        await this.server.start();
      } catch (err) {
        if (gen !== this.generation) throw new CancelledError();
        throw err;
      }
      if (gen !== this.generation) throw new CancelledError();
      const port = this.server.port;
      if (port === null) throw new Error('IDE server has no port');
      try {
        this.lockPath = writeLockFile(this.cfg.lockDir, port, {
          pid: this.cfg.pid,
          workspaceFolders: workspaceFoldersFor(this.cfg.vaultPath),
          ideName: IDE_NAME,
          transport: 'ws',
          authToken: this.server.token,
        });
      } catch (err) {
        // Without a lock file no Claude Code can find the server or its token.
        this.server.stop();
        throw err;
      }
      this.cfg.log.debug(`IDE lock file written: ${this.lockPath}`);
    };
    const promise = run();
    this.pending = promise;
    promise
      .catch(() => {})
      .finally(() => {
        if (this.pending === promise) this.pending = null;
      });
    return promise;
  }

  /** Removes the lock file and closes the server (R10.9, R10.10). */
  disable(): void {
    this.generation++;
    this.pending = null;
    if (this.lockPath) {
      removeLockFile(this.lockPath, this.server.token);
      this.lockPath = null;
    }
    this.server.stop();
  }

  dispose(): void {
    this.disable();
    this.server.dispose();
  }
}

/**
 * T7 — Claude Code IDE connection (D27a, D29, D30): WebSocket MCP server + `~/.claude/ide/<port>.lock`, started in the
 * ready gate when `ideConnectionEnabled`; spawn contributor `ide:claude` adds `--ide` + `CLAUDE_CODE_SSE_PORT` to Claude
 * panels; stale Obsidian lock files are removed on load. Service: `ide`.
 */
export function createIdeModule(options: IdeModuleOptions = {}): FeatureModule {
  let conn: IdeConnection | null = null;
  let failureNotified = false;
  const lockDir = (): string => options.lockDir ?? ideLockDir();

  const enable = async (ctx: PluginContext, log: Logger): Promise<void> => {
    if (!conn) return;
    try {
      await conn.enable();
      failureNotified = false;
    } catch (err) {
      if (err instanceof CancelledError || ctx.unloading) return;
      log.error('Claude Code IDE connection could not start', err);
      if (!failureNotified) {
        notice('AI Terminal: the Claude Code IDE connection could not start — Claude will not see your selection automatically (the obsidian tools still work). See the developer console.');
      }
      failureNotified = true;
    }
  };

  return {
    id: 'ide',
    register(ctx) {
      const log = ctx.log.child('ide');
      // Looked up when used: bridgeState belongs to the bridge module (registered earlier).
      const state: SelectionSource = {
        currentSelection: () => ctx.services.get('bridgeState')?.currentSelection() ?? null,
        onChange: (fn) => ctx.services.get('bridgeState')?.onChange(fn) ?? (() => {}),
      };
      const server = new IdeServer({ log, state, version: ctx.plugin.manifest?.version, token: options.token, seedDelaysMs: options.seedDelaysMs });
      const connection = new IdeConnection(server, { lockDir: lockDir(), vaultPath: ctx.vaultPath, pid: options.pid ?? process.pid, log });
      conn = connection;
      ctx.services.provide('ide', connection);
      const hint = createDiffToolHint({
        isShown: () => ideData(ctx).diffHintShown === true,
        markShown: async () => {
          ctx.settings.moduleData.ide = { ...ideData(ctx), diffHintShown: true };
          await ctx.saveSettings();
        },
        configFile: () => claudeGlobalConfigFile(spawnEnv(ctx), ctx.vaultPath),
        log,
      });
      ctx.spawn.add(
        'ide:claude',
        createClaudeIdeContributor(() => (ctx.settings.ideConnectionEnabled && conn === connection ? connection : undefined), { hint }),
      );
      ctx.onSettingsChange((s, prev) => {
        if (s.ideConnectionEnabled === prev.ideConnectionEnabled || ctx.unloading) return;
        if (s.ideConnectionEnabled) void enable(ctx, log);
        else connection.disable();
      });
      const target = options.windowTarget !== undefined ? options.windowTarget : typeof window !== 'undefined' ? window : null;
      if (target) {
        const onPageUnload = (): void => connection.disable();
        for (const ev of PAGE_UNLOAD_EVENTS) target.addEventListener(ev, onPageUnload);
        ctx.onUnload(() => {
          for (const ev of PAGE_UNLOAD_EVENTS) target.removeEventListener(ev, onPageUnload);
        });
      }
    },
    async ready(ctx) {
      const log = ctx.log.child('ide');
      try {
        const { removed } = await cleanStaleLockFiles(lockDir(), options.isPidAlive ?? isPidAlive);
        if (removed.length) log.info(`removed ${removed.length} stale Obsidian IDE lock file(s): ${removed.join(', ')}`);
      } catch (err) {
        log.warn('stale IDE lock file cleanup failed', err);
      }
      if (ctx.settings.ideConnectionEnabled && !ctx.unloading) await enable(ctx, log);
    },
    unload() {
      conn?.dispose();
      conn = null;
    },
  };
}

/** Per-vault IDE module state in `settings.moduleData.ide`. */
interface IdeModuleData {
  /** The one-time Diff tool hint (R10.11) was printed in this vault. */
  diffHintShown?: boolean;
}

function ideData(ctx: PluginContext): IdeModuleData {
  const data = ctx.settings.moduleData.ide;
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as IdeModuleData) : {};
}

/** The environment Claude will see (login-shell layer), so `$CLAUDE_CONFIG_DIR` from the user's profile counts. */
function spawnEnv(ctx: PluginContext): Readonly<Record<string, string | undefined>> {
  try {
    return ctx.services.get('shellEnv')?.getSpawnEnv() ?? process.env;
  } catch {
    return process.env;
  }
}
