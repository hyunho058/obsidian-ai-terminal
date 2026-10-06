import type { FeatureModule } from '../core';

/**
 * T2 — login-shell environment capture and layering (D6). Publish the spawn env service in `register` (`ctx.services.provide('shellEnv', …)`) and capture it in `ready`.
 */
export function createEnvModule(): FeatureModule {
  return {
    id: 'env',
    register(_ctx) {
      // TODO(T2): implement.
    },
  };
}
