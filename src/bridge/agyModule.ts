import type { FeatureModule } from '../core';

/**
 * T8 — Antigravity bridge: `mcp_shim.py` (`ctx.supportScripts.register`), `agy mcp` entry, env contributor; reacts to `agyBridgeEnabled` via `ctx.onSettingsChange` (D28).
 */
export function createAgyModule(): FeatureModule {
  return {
    id: 'agy',
    register(_ctx) {
      // TODO(T8): implement.
    },
  };
}
