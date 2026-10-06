import type { FeatureModule } from '../core';

/**
 * T5 — conversation identity and resume (D21, D22), registered with `ctx.spawn.add('resume', …)` (uses `replaceArgs`, `sessionId`, `notice`, `fallback`).
 */
export function createResumeModule(): FeatureModule {
  return {
    id: 'resume',
    register(_ctx) {
      // TODO(T5): implement.
    },
  };
}
