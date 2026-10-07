import type { Vault } from 'obsidian';
import { isAiProfile, PROFILE_LABELS } from '../core/constants';
import type { SessionHandle, SessionsService } from '../session/types';
import type { Logger } from '../util/log';
import { formatTimestamp } from './messages';
import { waitAtMost } from './queue';
import { toArrayBuffer, VaultFiles } from './restoreVault';
import type { ChangedFile, ChangeStatus, SnapshotInfo, SnapshotsService } from './types';

export const RESTORE_COMMAND_ID = 'restore-notes';
/** Palette name (R1.1); Obsidian shows it as "AI Terminal: Restore notes from before an AI session…". */
export const RESTORE_COMMAND_NAME = 'Restore notes from before an AI session…';
export const RESTORE_COMMAND_ICON = 'history';
/** Commit label of the safety snapshot taken before every restore (R13.3, R13.5). */
export const BEFORE_RESTORE_LABEL = 'Before restore';
/** "Stop them and restore" waits at most this long for the AI programs to end (the PTY helper hard-kills after 5 s). */
export const STOP_WAIT_MS = 8_000;

/** "Claude Code" / "Antigravity" / "—" (unknown). */
export function aiLabel(info: Pick<SnapshotInfo, 'ai'>): string {
  return info.ai ? PROFILE_LABELS[info.ai] : '—';
}

const SUBJECT_TIME = / — \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/** What the snapshot was taken before: the prompt excerpt, or a short kind label. */
export function snapshotWhat(info: SnapshotInfo): string {
  switch (info.kind) {
    case 'prompt':
      if (info.promptExcerpt) return `"${info.promptExcerpt}"`;
      return info.ai === 'agy' ? 'before input' : 'before a message';
    case 'spawn':
      return 'session start';
    case 'restore':
      return 'before restore';
    case 'first':
      return 'first snapshot';
    default:
      return info.subject.replace(SUBJECT_TIME, '').trim() || 'snapshot';
  }
}

/** "…" while counting, "?" when counting failed. */
export function changedCountText(count: number | Error | undefined): string {
  if (count === undefined) return '…';
  if (count instanceof Error) return '?';
  if (count === 0) return 'no changes since';
  return `${count} ${count === 1 ? 'file' : 'files'} changed since`;
}

/** R13.6 dialog text. */
export function runningWarning(count: number): string {
  return count === 1
    ? '1 AI panel is running — it may overwrite restored notes and still remember the old content.'
    : `${count} AI panels are running — they may overwrite restored notes and still remember the old content.`;
}

/** Running Claude Code / Antigravity panels (shell panels never touch notes on their own). */
export function runningAiPanels(sessions: SessionsService | undefined): SessionHandle[] {
  return sessions ? sessions.list().filter((s) => isAiProfile(s.profile) && s.isRunning) : [];
}

/**
 * Stops the panels (R13.6 "Stop them and restore") and waits until every program ended, at most `waitMs`.
 * True if all ended in time.
 */
export async function stopPanels(
  sessions: SessionsService | undefined,
  panels: readonly SessionHandle[],
  log: Logger,
  waitMs = STOP_WAIT_MS,
): Promise<boolean> {
  if (!sessions || panels.length === 0) return true;
  const all = Promise.all(
    panels.map((p) => sessions.stop(p.panelId, 'restore').catch((err) => log.warn(`stopping ${p.label} before a restore failed`, err))),
  );
  const r = await waitAtMost(all, waitMs);
  if (!r.done) log.warn('AI panels did not stop in time — restoring anyway');
  return r.done;
}

/** Order of the file groups in the modal. */
export const STATUS_ORDER: readonly ChangeStatus[] = ['modified', 'deleted', 'created'];

export interface RestoreRequest {
  snapshot: SnapshotInfo;
  /** The ticked files — nothing else is touched (R13.4). */
  files: readonly ChangedFile[];
}

export interface RestoreUndoPoint {
  commit: string;
  /** Commit time (epoch ms), if known. */
  time: number | undefined;
  /** A new `Before restore` snapshot was committed; false = the vault already matched snapshot `commit`. */
  beforeRestore: boolean;
}

export interface RestoreDone {
  status: 'restored';
  /** Brought back to the snapshot version (modified / deleted). */
  restored: string[];
  /** Moved to `.trash/` (created after the snapshot). */
  trashed: string[];
  /** Created after the snapshot but already gone. */
  alreadyGone: string[];
  failed: Array<{ path: string; reason: string }>;
  undo: RestoreUndoPoint;
}

export interface RestoreAborted {
  status: 'aborted';
  /** Why the `Before restore` snapshot could not be taken — no note was changed. */
  reason: string;
}

export type RestoreOutcome = RestoreDone | RestoreAborted;
export type RestorePhase = 'snapshot' | 'restore';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Restores ticked notes from a snapshot (D33). One restore at a time per plugin instance. */
export class Restorer {
  private running = false;

  constructor(private readonly opts: { vault: Vault; log: Logger }) {}

  get busy(): boolean {
    return this.running;
  }

  /**
   * 1. `Before restore` snapshot (R13.3) — if it fails nothing is touched;
   * 2. files created after the snapshot → Obsidian's trash; modified / deleted files → snapshot content;
   * 3. sets the snapshot change flag.
   */
  async restore(snapshots: SnapshotsService, request: RestoreRequest, onPhase?: (phase: RestorePhase) => void): Promise<RestoreOutcome> {
    if (this.running) return { status: 'aborted', reason: 'another restore is still running' };
    this.running = true;
    try {
      return await this.run(snapshots, request, onPhase);
    } finally {
      this.running = false;
    }
  }

  private async run(snapshots: SnapshotsService, request: RestoreRequest, onPhase?: (phase: RestorePhase) => void): Promise<RestoreOutcome> {
    const { log } = this.opts;
    onPhase?.('snapshot');
    let undo: RestoreUndoPoint;
    try {
      const safety = await snapshots.snapshotNow({ kind: 'restore', label: BEFORE_RESTORE_LABEL });
      if ((safety.status !== 'committed' && safety.status !== 'unchanged') || !safety.commit) {
        const reason =
          safety.reason ??
          (safety.status === 'pending' ? 'it did not finish' : safety.status === 'disabled' ? 'snapshots are not available' : 'no snapshot holds the current notes');
        return { status: 'aborted', reason };
      }
      undo = { commit: safety.commit, time: await this.commitTime(snapshots, safety.commit), beforeRestore: safety.status === 'committed' };
      if (undo.time === undefined && undo.beforeRestore) undo.time = Date.now();
    } catch (err) {
      return { status: 'aborted', reason: message(err) };
    }

    onPhase?.('restore');
    const files = new VaultFiles(this.opts.vault);
    const done: RestoreDone = { status: 'restored', restored: [], trashed: [], alreadyGone: [], failed: [], undo };
    // Trash first, so a restored note can never land in a file that is trashed afterwards (macOS names that differ only
    // in case or Unicode normalization are the same file).
    const ordered = [...request.files].sort((a, b) => Number(b.status === 'created') - Number(a.status === 'created'));
    for (const f of ordered) {
      try {
        if (f.status === 'created') {
          if (await files.trash(f.path)) done.trashed.push(f.path);
          else done.alreadyGone.push(f.path);
        } else {
          const data = await snapshots.readFileAt(request.snapshot.commit, f.path);
          await files.write(f.path, toArrayBuffer(data));
          done.restored.push(f.path);
        }
      } catch (err) {
        log.warn(`restoring "${f.path}" failed`, err);
        done.failed.push({ path: f.path, reason: message(err) });
      }
    }
    snapshots.markChanged('restore');
    log.info(
      `restored ${done.restored.length}, trashed ${done.trashed.length}, failed ${done.failed.length} from ${request.snapshot.commit.slice(0, 8)}`,
    );
    return done;
  }

  /** Commit time of the newest snapshot if it is `commit` (the safety snapshot is always the newest). */
  private async commitTime(snapshots: SnapshotsService, commit: string): Promise<number | undefined> {
    try {
      const [head] = await snapshots.list({ limit: 1 });
      return head && head.commit === commit ? head.time : undefined;
    } catch {
      return undefined;
    }
  }
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "14:05" today, else "2026-10-06 14:05". */
export function formatWhen(time: number, now: Date = new Date()): string {
  const full = formatTimestamp(new Date(time));
  return sameDay(new Date(time), now) ? full.slice(11) : full;
}

function quotedList(paths: readonly string[], max = 3): string {
  const shown = paths.slice(0, max).map((p) => `"${p}"`);
  const more = paths.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/** Where to go to undo this restore (R13.5). */
export function undoHint(undo: RestoreUndoPoint, now: Date = new Date()): string {
  const when = undo.time !== undefined ? formatWhen(undo.time, now) : undefined;
  if (undo.beforeRestore) return `To undo, restore from '${BEFORE_RESTORE_LABEL}'${when ? ` at ${when}` : ''}.`;
  return `To undo, restore from the snapshot ${when ? `at ${when}` : undo.commit.slice(0, 8)}.`;
}

/** e.g. "AI Terminal: Restored 2 notes, moved 1 to trash. To undo, restore from 'Before restore' at 14:05." */
export function restoreSummary(done: RestoreDone, now: Date = new Date()): string {
  const n = done.restored.length;
  const m = done.trashed.length;
  const parts: string[] = [];
  if (n > 0) parts.push(`Restored ${n} ${n === 1 ? 'note' : 'notes'}`);
  if (m > 0) parts.push(`${n > 0 ? 'moved' : 'Moved'} ${m} to trash`);
  let text = parts.length > 0 ? `${parts.join(', ')}.` : 'No notes were changed.';
  if (done.failed.length > 0) {
    text += ` Could not restore ${quotedList(done.failed.map((f) => f.path))}: ${done.failed[0]!.reason}.`;
  }
  return `AI Terminal: ${text} ${undoHint(done.undo, now)}`;
}

/** The restore was cancelled because the safety snapshot failed (R13.3: never restore without it). */
export function abortedText(reason: string): string {
  return `Restore cancelled — the '${BEFORE_RESTORE_LABEL}' snapshot failed: ${reason}. No notes were changed.`;
}

export function abortedMessage(reason: string): string {
  return `AI Terminal: ${abortedText(reason)}`;
}
