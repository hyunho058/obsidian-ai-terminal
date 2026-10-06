import type { FeatureModule } from '../core';
import { SessionRegistry, type SessionRegistryOptions } from './SessionRegistry';

export * from './mirror';
export * from './profiles';
export * from './SessionRegistry';
export * from './types';

/**
 * T3 — session registry keyed by panelId (D34): headless mirror, reattach, duplicate rule, grace timer, ready gate.
 * Publishes the `sessions` service; every spawn awaits `ctx.ready`, `ctx.sessionEvents.runBeforeSpawn` and
 * `ctx.spawn.resolve` first. Unload stops every session without dialogs (R7.7, R7.8).
 */
export function createSessionModule(options: SessionRegistryOptions = {}): FeatureModule {
  let registry: SessionRegistry | undefined;
  return {
    id: 'session',
    register(ctx) {
      const sessions = new SessionRegistry(ctx, options);
      registry = sessions;
      ctx.services.provide('sessions', sessions);
      ctx.onSettingsChange((s, prev) => {
        if (s.scrollback === prev.scrollback) return;
        for (const session of sessions.list()) sessions.mirrorOf(session.panelId)?.setScrollback(s.scrollback);
      });
    },
    unload() {
      registry?.dispose();
      registry = undefined;
    },
  };
}
