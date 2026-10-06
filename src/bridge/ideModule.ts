import type { FeatureModule } from '../core';

/**
 * T7 — Claude Code IDE connection: WebSocket MCP server, lock file, `--ide` + `CLAUDE_CODE_SSE_PORT` contributor (D27a, D29).
 */
export function createIdeModule(): FeatureModule {
  return {
    id: 'ide',
    register(_ctx) {
      // TODO(T7): implement.
    },
  };
}
