import type { FeatureModule } from '../core';
import { notice } from '../util/log';
import { createClaudeMcpContributor } from './claudeMcpContributor';
import { BridgeHttpServer } from './httpServer';
import { BridgeState } from './state';
import { createBridgeMcpServer } from './tools';

export { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, MCP_SERVER_NAME, claudeMcpConfig, createClaudeMcpContributor } from './claudeMcpContributor';
export { BRIDGE_HOST, MCP_PATH, BridgeHttpServer, type BridgeServerService } from './httpServer';
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
 */
export function createBridgeModule(options: BridgeModuleOptions = {}): FeatureModule {
  let state: BridgeState | null = null;
  let server: BridgeHttpServer | null = null;
  let startFailed = false;

  const startServer = async (log: { error(...a: unknown[]): void }): Promise<void> => {
    if (!server) return;
    try {
      await server.start();
      startFailed = false;
    } catch (err) {
      log.error('bridge server could not start', err);
      if (!startFailed) notice('AI Terminal: the Obsidian bridge could not start — AI tools cannot see your notes. See the developer console.');
      startFailed = true;
    }
  };

  return {
    id: 'bridge',
    register(ctx) {
      const log = ctx.log.child('bridge');
      const bridgeState = new BridgeState({ app: ctx.app, vaultPath: ctx.vaultPath, log, debounceMs: options.debounceMs });
      bridgeState.start();
      ctx.plugin.registerEditorExtension(bridgeState.editorExtension());
      const httpServer = new BridgeHttpServer({
        routes: ctx.routes,
        createMcpServer: () => createBridgeMcpServer(bridgeState),
        log,
        token: options.token,
      });
      state = bridgeState;
      server = httpServer;
      ctx.services.provide('bridgeState', bridgeState);
      ctx.services.provide('bridgeServer', httpServer);
      ctx.spawn.add('bridge:claude-mcp-config', createClaudeMcpContributor(() => (ctx.settings.bridgeEnabled ? httpServer : undefined)));
      ctx.onSettingsChange((s, prev) => {
        if (s.bridgeEnabled === prev.bridgeEnabled || ctx.unloading) return;
        if (s.bridgeEnabled) void startServer(log);
        else httpServer.stop();
      });
    },
    async ready(ctx) {
      if (ctx.settings.bridgeEnabled && !ctx.unloading) await startServer(ctx.log.child('bridge'));
    },
    unload() {
      server?.dispose();
      state?.dispose();
      server = null;
      state = null;
    },
  };
}
