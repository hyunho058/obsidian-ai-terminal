import type { App, Scope } from 'obsidian';
import type { FeatureModule } from '../core';
import { createClipboard, createKeyRouter, createTerminalScope, terminalOwnsKey, type TerminalClipboard } from './keyboard';
import type { TerminalView } from './TerminalView';

export interface KeyboardModuleOptions {
  /** Safety cap for the Enter hold (tests). */
  enterHoldCapMs?: number;
  /** Clipboard override (tests). */
  clipboard?: TerminalClipboard;
}

/**
 * T4 — keyboard routing (D10): IME guard, Cmd / Option / Shift+Enter mapping and the Enter-interceptor dispatcher via
 * `ctx.keyboard.onKey`, plus hotkey isolation through each terminal view's `scope`.
 */
export function createKeyboardModule(options: KeyboardModuleOptions = {}): FeatureModule {
  return {
    id: 'keyboard',
    label: 'keyboard handling',
    register(ctx) {
      const log = ctx.log.child('keyboard');
      const terminals = ctx.services.require('terminals');
      ctx.keyboard.onKey(
        createKeyRouter({
          optionIsMeta: () => ctx.settings.optionIsMeta,
          interceptors: () => ctx.keyboard.enterInterceptors(),
          clipboard: options.clipboard ?? createClipboard(),
          // Through the detach wrapper of the close flow: asks first while the program runs (R7.3, R7.5).
          close: (panel) => terminals.viewOf(panel.panelId)?.leaf.detach(),
          log,
          enterHoldCapMs: options.enterHoldCapMs,
        }),
      );

      const isolate = (view: TerminalView): void => {
        const appScope = (ctx.app as App & { scope?: Scope }).scope;
        view.scope = createTerminalScope(appScope, (event) => terminalOwnsKey(event, view));
      };
      ctx.onUnload(terminals.onViewOpen(isolate));
      for (const view of terminals.views()) isolate(view);
    },
  };
}
