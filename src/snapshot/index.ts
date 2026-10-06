import type { FeatureModule } from '../core';

/**
 * T9 — snapshots before every AI message (D31, D32): `/snapshot` via `ctx.routes.addRoute`, `snapshot_hook.py` + `--settings` contributor, agy Enter hold via `ctx.keyboard.onEnterIntercept`, spawn-time snapshot via `ctx.sessionEvents.beforeSpawn`.
 */
export function createSnapshotModule(): FeatureModule {
  return {
    id: 'snapshot',
    register(_ctx) {
      // TODO(T9): implement.
    },
  };
}
