import type { FeatureModule, PluginContext } from '../core';
import { notice, type Logger } from '../util/log';
import { createClaudeMcpContributor } from './claudeMcpContributor';
import { BridgeHttpServer, BridgeStartAbortedError } from './httpServer';
import { BridgeState } from './state';
import { createBridgeMcpServer } from './tools';

export { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, MCP_SERVER_NAME, claudeMcpConfig, createClaudeMcpContributor } from './claudeMcpContributor';
export {
  BRIDGE_HOST,
  MCP_PATH,
  NOT_IN_USE_MESSAGE,
  REFUSED_STATUS,
  TOOLS_OFF_MESSAGE,
  BridgeHttpServer,
  BridgeStartAbortedError,
  type BridgeEndpoint,
  type BridgeServerService,
} from './httpServer';
export { BridgeError, toVaultPath } from './paths';
export {
  BridgeState,
  SELECTION_DEBOUNCE_MS,
  type BridgeChange,
  type BridgeStateService,
  type EditorSelectionSnapshot,
  type NotePosition,
} from './state';
export { BRIDGE_TOOL_NAMES, createBridgeMcpServer, registerBridgeTools } from './tools';

export interface BridgeModuleOptions {
  /** Selection-change debounce (tests). */
  debounceMs?: number;
  /** Fixed bearer token (tests). */
  token?: string;
}

/**
 * T6 — bridge state reader (D24), the five MCP tools and the HTTP MCP server (D11, D27b) serving `ctx.routes`;
 * Claude panels get it through `--mcp-config` (D28). Services: `bridgeState`, `bridgeServer`.
 * The server is in use while the bridge tools are on or another module needs it (`keepRunningWhile`, e.g. snapshots'
 * `/snapshot`); with the tools off it serves only `ctx.routes` and no spawn gets `--mcp-config` (deviation 19). It binds
 * the first time it is in use and keeps that port until unload, refusing requests while not in use (deviation 20).
 */
export function createBridgeModule(options: BridgeModuleOptions = {}): FeatureModule {
  let state: BridgeState | null = null;
  let server: BridgeHttpServer | null = null;
  let failureNotified = false;
  /** Set in `register`: the first decision, made in the ready gate. */
  let startWhenReady: (() => Promise<void>) | null = null;

  const startServer = async (ctx: PluginContext, log: Logger, srv: BridgeHttpServer): Promise<void> => {
    try {
      await srv.start();
      failureNotified = false;
    } catch (err) {
      // Closed while starting = plugin unload: nothing was lost that the user needs to hear about.
      if (err instanceof BridgeStartAbortedError || ctx.unloading) return;
      log.error('bridge server could not start', err);
      const lost = lostWithoutServer(ctx, srv);
      if (!failureNotified && lost.length > 0) {
        notice(bridgeStartFailedNotice(lost));
        failureNotified = true;
      }
    }
  };

  return {
    id: 'bridge',
    label: 'the Obsidian bridge',
    register(ctx) {
      const log = ctx.log.child('bridge');
      const bridgeState = new BridgeState({ app: ctx.app, vaultPath: ctx.vaultPath, log, debounceMs: options.debounceMs });
      bridgeState.start();
      ctx.plugin.registerEditorExtension(bridgeState.editorExtension());
      // Deviation 20: the first time the server is in use it binds a port and keeps it until unload. Later "not in use"
      // only makes it refuse requests (the server checks per request). Checked once ready, then after settings and
      // demand changes; a failed start is retried the next time it becomes in use.
      let inUse: boolean | null = null;
      let starting = false;
      const sync = (): void => {
        if (inUse === null || ctx.unloading || server !== httpServer) return;
        const want = httpServer.isServing();
        if (want === inUse) return;
        inUse = want;
        if (!want) {
          if (httpServer.isRunning()) log.info('bridge not in use: refusing requests (the port is kept until unload)');
          return;
        }
        if (httpServer.isRunning()) {
          log.info('bridge in use again');
          return;
        }
        if (starting) return;
        starting = true;
        void startServer(ctx, log, httpServer).finally(() => (starting = false));
      };
      const httpServer = new BridgeHttpServer({
        routes: ctx.routes,
        createMcpServer: () => createBridgeMcpServer(bridgeState),
        log,
        token: options.token,
        serveMcp: () => ctx.settings.bridgeEnabled,
        onDemandChange: sync,
      });
      state = bridgeState;
      server = httpServer;
      ctx.services.provide('bridgeState', bridgeState);
      ctx.services.provide('bridgeServer', httpServer);
      ctx.spawn.add('bridge:claude-mcp-config', createClaudeMcpContributor(() => (ctx.settings.bridgeEnabled ? httpServer : undefined)));
      ctx.onSettingsChange(sync);
      startWhenReady = async () => {
        inUse = false;
        sync();
        await httpServer.whenListening().catch(() => {});
      };
    },
    async ready(ctx) {
      if (!ctx.unloading) await startWhenReady?.();
    },
    unload() {
      server?.dispose();
      state?.dispose();
      server = null;
      state = null;
      startWhenReady = null;
    },
  };
}

/** What stops working while the server cannot start, in plain words (bridge tools, then each `keepRunningWhile` need). */
function lostWithoutServer(ctx: PluginContext, srv: BridgeHttpServer): string[] {
  const lost = ctx.settings.bridgeEnabled ? ['AI tools cannot see your notes'] : [];
  for (const reason of srv.neededFor()) lost.push(reason === 'snapshots' ? 'Claude Code messages are not snapshotted' : `${reason} cannot use it`);
  return lost;
}

/** The one Notice for a bridge server that could not start; names everything that is lost. */
export function bridgeStartFailedNotice(lost: readonly string[]): string {
  const what = lost.length <= 1 ? (lost[0] ?? 'AI tools cannot see your notes') : `${lost.slice(0, -1).join(', ')} and ${lost[lost.length - 1]}`;
  return `AI Terminal: the bridge server could not start, so ${what}. Reload the plugin to try again.`;
}
