import type { FeatureModule } from '../core';

/**
 * T2 — PTY helper (`pty_bridge.py`, run from `ctx.pluginDir`) and process wrapper with Python lookup (D7, D8). Publish the PTY process factory (`ctx.services.provide('pty', …)`).
 */
export function createPtyModule(): FeatureModule {
  return {
    id: 'pty',
    register(_ctx) {
      // TODO(T2): implement.
    },
  };
}
