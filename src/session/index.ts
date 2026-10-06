import type { FeatureModule } from '../core';

/**
 * T3 — session registry keyed by panelId (D34): headless mirror, reattach, duplicate rule, grace timer, ready gate. Publish it as `ctx.services.provide('sessions', …)`; the launcher awaits `ctx.ready`, `ctx.sessionEvents.runBeforeSpawn` and `ctx.spawn.resolve` before every spawn.
 */
export function createSessionModule(): FeatureModule {
  return {
    id: 'session',
    register(_ctx) {
      // TODO(T3): implement.
    },
  };
}
