import type { SpawnContributor } from '../core';
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV } from './claudeMcpContributor';
import type { BridgeServerService } from './httpServer';

/** How long an agy spawn waits for a bridge server that is still starting. */
export const AGY_START_WAIT_MS = 3000;

export interface AgyEnvContributorOptions {
  /** The running bridge server, or undefined when the bridge is disabled. */
  getServer: () => BridgeServerService | undefined;
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

async function listensWithin(server: BridgeServerService, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([server.whenListening().then(() => true, () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
