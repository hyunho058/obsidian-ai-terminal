import { isAiProfile, type BeforeSpawnHook } from '../core';
import type { FirstUsePrompt } from './firstUse';
import type { GitAvailability } from './git';
import { NOTES } from './messages';
import type { SnapshotsService } from './types';

/** How long a spawn waits for its snapshot (D31: at most 10 s, then it starts anyway). */
export const SPAWN_WAIT_MS = 10_000;

export interface SpawnSnapshotOptions {
  service: Pick<SnapshotsService, 'requestSnapshot'> & { checkAvailability(): Promise<GitAvailability> };
  /** `settings.snapshots.enabled` at use time. */
  enabledSetting: () => boolean | null;
  firstUse: Pick<FirstUsePrompt, 'ask'>;
  /** git is unusable and snapshots are on / not yet decided (R12.16). */
  onUnavailable: (reason: string) => void;
  waitMs?: number;
}

/**
 * `beforeSpawn` hook for AI panels (new / restored / restarted): asks the first-use question while
 * `snapshots.enabled` is null (R12.1), otherwise takes a snapshot if the change flag is set (R12.8). Shell panels
 * never snapshot (R12.15). Never throws and never blocks longer than the wait (or the user's answer).
 */
export function createSpawnSnapshotHook(o: SpawnSnapshotOptions): BeforeSpawnHook {
  return async (b) => {
    if (!isAiProfile(b.profile)) return;
    const availability = await o.service.checkAvailability();
    const setting = o.enabledSetting();
    if (!availability.ok) {
      if (setting !== false) o.onUnavailable(availability.reason);
      return;
    }
    if (setting === null) {
      // The first full snapshot starts in the background once the answer is stored (settings listener).
      if ((await o.firstUse.ask()) === 'enable') b.print(NOTES.enabled);
      return;
    }
    if (setting !== true) return;
    const r = await o.service.requestSnapshot({ kind: 'spawn', ai: b.profile, panelId: b.panelId }, { waitMs: o.waitMs ?? SPAWN_WAIT_MS });
    if (r.status === 'pending') b.print(NOTES.spawnPending);
    else if (r.status === 'failed') b.print(NOTES.spawnFailed(r.reason ?? 'unknown error'));
  };
}
