import type { FeatureModule } from '../core';
import { CloseFlow, type ConfirmClose } from './closeFlow';

export interface CloseFlowModuleOptions {
  stopWaitMs?: number;
  /** Replaces the confirmation dialog (tests). */
  confirm?: ConfirmClose;
}

/**
 * T4 — close flow (D26): Cmd+W (from the keyboard routing) and every tab close go through the `WorkspaceLeaf.detach`
 * wrapper, which asks before closing a running terminal; no dialog on quit, popout close, layout load or unload.
 */
export function createCloseFlowModule(options: CloseFlowModuleOptions = {}): FeatureModule {
  let flow: CloseFlow | null = null;
  return {
    id: 'close-flow',
    label: 'close confirmation',
    register(ctx) {
      const terminals = ctx.services.require('terminals');
      const current = new CloseFlow({
        app: ctx.app,
        terminals,
        sessions: ctx.services.require('sessions'),
        log: ctx.log.child('close-flow'),
        isTearingDown: () => terminals.isTearingDown() || ctx.unloading,
        stopWaitMs: options.stopWaitMs,
        confirm: options.confirm,
      });
      ctx.plugin.registerEvent(ctx.app.workspace.on('quit', () => current.markQuitting()));
      current.install();
      flow = current;
    },
    unload() {
      flow?.uninstall();
      flow = null;
    },
  };
}
