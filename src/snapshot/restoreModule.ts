import type { FeatureModule, PluginContext } from '../core';
import { notice } from '../util/log';
import { Restorer, RESTORE_COMMAND_ICON, RESTORE_COMMAND_ID, RESTORE_COMMAND_NAME } from './restore';
import { RestoreModal, type RestoreModalOptions } from './restoreModal';

export type RestoreModuleOptions = Pick<RestoreModalOptions, 'pageSize' | 'countBatch' | 'stopWaitMs' | 'notify'>;

/** Shown when git cannot be used (the reason comes from the snapshot service's git check). */
export function unavailableMessage(reason: string): string {
  return `AI Terminal: notes can't be restored — git is not available: ${reason}.`;
}

/**
 * T10 — "Restore notes from before an AI session…" command and modal (D33, R13) on the T9 `snapshots` service.
 */
export function createRestoreModule(options: RestoreModuleOptions = {}): FeatureModule {
  const open = new Set<RestoreModal>();
  let restorer: Restorer | null = null;

  const openRestore = (ctx: PluginContext): RestoreModal | null => {
    const notify = options.notify ?? ((m: string, t?: number) => void notice(m, t));
    const snapshots = ctx.services.get('snapshots');
    if (!snapshots || !restorer) {
      notify('AI Terminal: notes can\'t be restored — the snapshot feature did not start (see the developer console).');
      return null;
    }
    // Without a reason the git check is still running: the modal waits for it (list() rejects if git is unusable).
    const reason = snapshots.isAvailable() ? undefined : snapshots.unavailableReason();
    if (reason) {
      notify(unavailableMessage(reason), 10_000);
      return null;
    }
    const modal = new RestoreModal(ctx.app, {
      ...options,
      snapshots,
      sessions: () => ctx.services.get('sessions'),
      restorer,
      log: ctx.log.child('restore'),
      snapshotsSetting: () => ctx.settings.snapshots.enabled,
      onClosed: () => open.delete(modal),
    });
    open.add(modal);
    modal.openInActiveWindow();
    return modal;
  };

  return {
    id: 'restore',
    register(ctx) {
      restorer = new Restorer({ vault: ctx.app.vault, log: ctx.log.child('restore') });
      ctx.plugin.addCommand({
        id: RESTORE_COMMAND_ID,
        name: RESTORE_COMMAND_NAME,
        icon: RESTORE_COMMAND_ICON,
        callback: () => {
          try {
            openRestore(ctx);
          } catch (err) {
            ctx.log.error('opening the restore dialog failed', err);
          }
        },
      });
    },
    unload() {
      for (const modal of [...open]) modal.close();
      open.clear();
      restorer = null;
    },
  };
}
