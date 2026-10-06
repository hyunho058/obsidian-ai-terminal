import type { FeatureModule } from '../core';

/**
 * T4 — close flow (D26): Cmd+W, `WorkspaceLeaf.detach` wrapper, batch dialog; no dialog while `ctx.unloading`.
 */
export function createCloseFlowModule(): FeatureModule {
  return {
    id: 'close-flow',
    register(_ctx) {
      // TODO(T4): implement.
    },
  };
}
