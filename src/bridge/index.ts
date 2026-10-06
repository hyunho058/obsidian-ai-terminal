import type { FeatureModule } from '../core';

/**
 * T6 — bridge state reader, 5 MCP tools and the HTTP MCP server (D24, D27b); serves `ctx.routes`; Claude `--mcp-config` via `ctx.spawn.add`.
 */
export function createBridgeModule(): FeatureModule {
  return {
    id: 'bridge',
    register(_ctx) {
      // TODO(T6): implement.
    },
  };
}
