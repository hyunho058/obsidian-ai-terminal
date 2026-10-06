import type { FeatureModule } from '../core';

/**
 * T3 — terminal ItemView (`TERMINAL_VIEW_TYPE`), xterm + addons, theme, commands, ribbon menu, placement. Key events go through `ctx.keyboard.dispatchKey`.
 */
export function createTerminalModule(): FeatureModule {
  return {
    id: 'terminal',
    register(_ctx) {
      // TODO(T3): implement.
    },
  };
}
