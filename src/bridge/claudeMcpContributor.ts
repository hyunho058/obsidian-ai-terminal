import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, MCP_SERVER_NAME, type SpawnContributor } from '../core';
import { listensWithin } from '../util/wait';
import type { BridgeEndpoint } from './httpServer';

// The names live in core/constants.ts; re-exported here for older imports.
export { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, MCP_SERVER_NAME };
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
export function createClaudeMcpContributor(getServer: () => BridgeEndpoint | undefined): SpawnContributor {
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
