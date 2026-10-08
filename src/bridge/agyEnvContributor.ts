import type { SpawnContributor } from '../core';
import { listensWithin } from '../util/wait';
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV } from './claudeMcpContributor';
import type { BridgeEndpoint } from './httpServer';

/** How long an agy spawn waits for a bridge server that is still starting. */
export const AGY_START_WAIT_MS = 3000;

export interface AgyEnvContributorOptions {
  /** The bridge server, or undefined while the bridge tools are off (the shim needs `/mcp`). */
  getServer: () => BridgeEndpoint | undefined;
  /** `settings.agyBridgeEnabled`, read at spawn time. */
  enabled: () => boolean;
  startWaitMs?: number;
}

/**
 * Spawn contributor for agy panels (D28): the bridge's base URL and token in the environment. agy passes its
 * environment to the stdio MCP servers it starts (verified with agy 1.3.0), so the global `obsidian` entry's shim
 * reaches this vault's bridge only from agy sessions started by this plugin.
 */
export function createAgyEnvContributor(opts: AgyEnvContributorOptions): SpawnContributor {
  return async (c) => {
    if (c.profile !== 'agy' || !opts.enabled()) return;
    const server = opts.getServer();
    if (!server) return;
    if (!server.isRunning() && !(await listensWithin(server, opts.startWaitMs ?? AGY_START_WAIT_MS))) return;
    const baseUrl = server.baseUrl;
    if (!baseUrl) return;
    return { env: { [BRIDGE_URL_ENV]: baseUrl, [BRIDGE_TOKEN_ENV]: server.token } };
  };
}
