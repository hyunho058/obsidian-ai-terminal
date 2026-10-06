import type { FeatureModule } from '../core';

/**
 * T10 — "Restore notes from before an AI session…" command and modal (D33).
 */
export function createRestoreModule(): FeatureModule {
  return {
    id: 'restore',
    register(_ctx) {
      // TODO(T10): implement.
    },
  };
}
