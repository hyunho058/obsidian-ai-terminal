import type { FeatureModule } from '../core';

/**
 * T4 — keyboard routing (D10) registered via `ctx.keyboard.onKey`; runs `ctx.keyboard.enterInterceptors()` before forwarding Enter.
 */
export function createKeyboardModule(): FeatureModule {
  return {
    id: 'keyboard',
    register(_ctx) {
      // TODO(T4): implement.
    },
  };
}
