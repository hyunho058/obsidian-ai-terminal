import type { EnterInterceptor } from '../core';
import { noteFor, printNote } from './endpoint';
import type { SnapshotsService } from './types';

/** How long an Enter in an agy panel waits for its snapshot (D31). */
export const AGY_WAIT_MS = 2_000;

/**
 * R12.7 — Enter interceptor for Antigravity panels (agy has no prompt-submit hook). Follows T4's contract: returns at
 * once unless this is an agy panel with snapshots on and the change flag set; otherwise snapshots and resolves when it
 * finished or after 2 s (printing the "still running" note). T4 holds the Enter and later input meanwhile; this never
 * sends input or holds it itself.
 */
export function createAgyEnterInterceptor(
  service: Pick<SnapshotsService, 'isEnabled' | 'hasChanges' | 'requestSnapshot'>,
  waitMs: number = AGY_WAIT_MS,
): EnterInterceptor {
  return (panel) => {
    if (panel.profile !== 'agy') return;
    if (!service.isEnabled() || !service.hasChanges()) return;
    return service.requestSnapshot({ kind: 'prompt', ai: 'agy', panelId: panel.panelId }, { waitMs }).then(
      (result) => {
        const note = noteFor(result, 'agy');
        if (note) printNote(panel, note);
      },
      () => undefined,
    );
  };
}
