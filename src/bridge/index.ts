import type { FeatureModule, PluginContext } from '../core';
import { notice, type Logger } from '../util/log';
import { createClaudeMcpContributor } from './claudeMcpContributor';
import { BridgeHttpServer } from './httpServer';
import { BridgeState } from './state';
import { createBridgeMcpServer } from './tools';

export { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, MCP_SERVER_NAME, claudeMcpConfig, createClaudeMcpContributor } from './claudeMcpContributor';
export { BRIDGE_HOST, MCP_PATH, BridgeHttpServer, type BridgeEndpoint, type BridgeServerService } from './httpServer';
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
 * The server listens while the bridge tools are on or another module needs it (`keepRunningWhile`, e.g. snapshots'
 * `/snapshot`); with the tools off it serves only `ctx.routes` and no spawn gets `--mcp-config` (deviation 19).
 */
export function createBridgeModule(options: BridgeModuleOptions = {}): FeatureModule {
  let state: BridgeState | null = null;
  let server: BridgeHttpServer | null = null;
  let startFailed = false;
  /** Set in `register`: the first start / stop decision, made in the ready gate. */
  let startWhenReady: (() => Promise<void>) | null = null;

  const startServer = async (ctx: PluginContext, log: Logger): Promise<void> => {
    if (!server) return;
    try {
      await server.start();
      startFailed = false;
    } catch (err) {
      log.error('bridge server could not start', err);
      if (!startFailed && !ctx.unloading) {
        const lost = ctx.settings.bridgeEnabled ? 'AI tools cannot see your notes' : 'Claude Code messages are not snapshotted';
        notice(`AI Terminal: the bridge server could not start, so ${lost}. Reload the plugin to try again.`);
      }
      startFailed = true;
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
      // Start / stop only when the answer changes; checked once ready, then after settings changes and demand changes.
      let wanted: boolean | null = null;
      const sync = (): void => {
        if (wanted === null || ctx.unloading || server !== httpServer) return;
        const want = ctx.settings.bridgeEnabled || httpServer.neededFor().length > 0;
        if (want === wanted) return;
        wanted = want;
        if (want) void startServer(ctx, log);
        else httpServer.stop();
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
        wanted = false;
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
