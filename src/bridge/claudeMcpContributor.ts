import type { SpawnContributor } from '../core';
import type { BridgeServerService } from './httpServer';

/** Name of the MCP server as Claude Code shows it (`mcp__obsidian__get_active_note` …). */
export const MCP_SERVER_NAME = 'obsidian';
/** Environment variables carrying the bridge's connection info into AI sessions (Claude here; agy shim / snapshot hook reuse them). */
export const BRIDGE_TOKEN_ENV = 'OBSIDIAN_BRIDGE_TOKEN';
/** `http://127.0.0.1:<port>` — no trailing slash; append `/mcp` or a route path such as `/snapshot`. */
export const BRIDGE_URL_ENV = 'OBSIDIAN_BRIDGE_URL';
/** How long a spawn waits for a bridge server that is still starting. */
const START_WAIT_MS = 3000;

/**
 * The session-only MCP config for Claude Code (D28, R11.1). The token is not in the JSON: Claude Code expands
 * `${OBSIDIAN_BRIDGE_TOKEN}` from its environment (verified with 2.1.291), so the token never appears in the
 * process arguments (`ps` shows argv to every local user; another user cannot read the environment).
 */
export function claudeMcpConfig(mcpUrl: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer \${${BRIDGE_TOKEN_ENV}}` } },
    },
  });
}

/**
 * Spawn contributor for Claude panels: `--mcp-config=<json>` plus the token / URL in the environment. Nothing is written
 * to `~/.claude.json`, `~/.claude/settings.json` or `.mcp.json`. The `=` form matters: `--mcp-config` is variadic, so
 * the separate-value form would swallow following positional arguments.
 */
export function createClaudeMcpContributor(getServer: () => BridgeServerService | undefined): SpawnContributor {
  return async (c) => {
    if (c.profile !== 'claude') return;
    const server = getServer();
    if (!server) return;
    if (!server.isRunning() && !(await listensWithin(server, START_WAIT_MS))) return;
    const url = server.url;
    const baseUrl = server.baseUrl;
    if (!url || !baseUrl) return;
    return {
      args: [`--mcp-config=${claudeMcpConfig(url)}`],
      env: { [BRIDGE_TOKEN_ENV]: server.token, [BRIDGE_URL_ENV]: baseUrl },
    };
  };
}

/** True if the server is (or becomes) listening within `ms`; false if it is disabled, failed or too slow. */
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
