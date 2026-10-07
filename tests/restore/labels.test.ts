// Text shown by the restore command (R13.1, R13.6) and the summary Notice.
import { describe, expect, it } from 'vitest';
import {
  abortedMessage,
  aiLabel,
  changedCountText,
  formatWhen,
  restoreSummary,
  runningAiPanels,
  runningWarning,
  snapshotWhat,
  undoHint,
  type RestoreDone,
} from '../../src/snapshot/restore';
import { fakeSession, fakeSessions, info } from './helpers';

const NOW = new Date(2026, 9, 7, 16, 0);
const AT_1405 = new Date(2026, 9, 7, 14, 5).getTime();

function done(over: Partial<RestoreDone> = {}): RestoreDone {
  return { status: 'restored', restored: [], trashed: [], alreadyGone: [], failed: [], undo: { commit: 'a'.repeat(40), time: AT_1405, beforeRestore: true }, ...over };
}

describe('labels', () => {
  it('which AI and what the snapshot was taken before', () => {
    expect(aiLabel({ ai: 'claude' })).toBe('Claude Code');
    expect(aiLabel({ ai: 'agy' })).toBe('Antigravity');
    expect(aiLabel({})).toBe('—');
    expect(snapshotWhat(info('c', { kind: 'prompt', ai: 'claude', promptExcerpt: 'make it shorter' }))).toBe('"make it shorter"');
    expect(snapshotWhat(info('c', { kind: 'prompt', ai: 'claude' }))).toBe('before a message');
    expect(snapshotWhat(info('c', { kind: 'prompt', ai: 'agy' }))).toBe('before input');
    expect(snapshotWhat(info('c', { kind: 'spawn', ai: 'agy' }))).toBe('session start');
    expect(snapshotWhat(info('c', { kind: 'restore' }))).toBe('before restore');
    expect(snapshotWhat(info('c', { kind: 'first' }))).toBe('first snapshot');
    expect(snapshotWhat(info('c', { kind: 'unknown', subject: 'Manual commit — 2026-10-07 14:03' }))).toBe('Manual commit');
    expect(snapshotWhat(info('c', { kind: 'unknown', subject: '' }))).toBe('snapshot');
  });

  it('files changed since', () => {
    expect(changedCountText(undefined)).toBe('…');
    expect(changedCountText(new Error('x'))).toBe('?');
    expect(changedCountText(0)).toBe('no changes since');
    expect(changedCountText(1)).toBe('1 file changed since');
    expect(changedCountText(12)).toBe('12 files changed since');
  });

  it('running AI panels: only Claude Code / Antigravity panels that run count (R13.6)', () => {
    const { service } = fakeSessions([fakeSession('claude', true), fakeSession('agy', true), fakeSession('shell', true), fakeSession('agy', false)]);
    expect(runningAiPanels(service).map((s) => s.profile)).toEqual(['claude', 'agy']);
    expect(runningAiPanels(undefined)).toEqual([]);
    expect(runningWarning(2)).toBe('2 AI panels are running — they may overwrite restored notes and still remember the old content.');
    expect(runningWarning(1)).toBe('1 AI panel is running — it may overwrite restored notes and still remember the old content.');
  });
});

describe('summary Notice', () => {
  it('restored / trashed counts and the undo point', () => {
    expect(restoreSummary(done({ restored: ['a', 'b'], trashed: ['c'] }), NOW)).toBe(
      "AI Terminal: Restored 2 notes, moved 1 to trash. To undo, restore from 'Before restore' at 14:05.",
    );
    expect(restoreSummary(done({ restored: ['a'] }), NOW)).toBe("AI Terminal: Restored 1 note. To undo, restore from 'Before restore' at 14:05.");
    expect(restoreSummary(done({ trashed: ['c', 'd'] }), NOW)).toBe("AI Terminal: Moved 2 to trash. To undo, restore from 'Before restore' at 14:05.");
    expect(restoreSummary(done({ alreadyGone: ['x'] }), NOW)).toBe("AI Terminal: No notes were changed. To undo, restore from 'Before restore' at 14:05.");
  });

  it('failures list up to three paths and the first reason', () => {
    const failed = ['a.md', 'b.md', 'c.md', 'd.md'].map((path) => ({ path, reason: 'EACCES' }));
    expect(restoreSummary(done({ restored: ['ok.md'], failed }), NOW)).toBe(
      'AI Terminal: Restored 1 note. Could not restore "a.md", "b.md", "c.md" and 1 more: EACCES. To undo, restore from \'Before restore\' at 14:05.',
    );
  });

  it('undo hint: time today, date otherwise; an existing snapshot when nothing new was committed', () => {
    expect(formatWhen(AT_1405, NOW)).toBe('14:05');
    expect(formatWhen(AT_1405, new Date(2026, 9, 8, 9, 0))).toBe('2026-10-07 14:05');
    expect(undoHint({ commit: 'a'.repeat(40), time: undefined, beforeRestore: true })).toBe("To undo, restore from 'Before restore'.");
    expect(undoHint({ commit: 'b'.repeat(40), time: AT_1405, beforeRestore: false }, NOW)).toBe('To undo, restore from the snapshot at 14:05.');
    expect(undoHint({ commit: 'b'.repeat(40), time: undefined, beforeRestore: false }, NOW)).toBe('To undo, restore from the snapshot bbbbbbbb.');
  });

  it('cancelled restore', () => {
    expect(abortedMessage('disk full')).toBe("AI Terminal: Restore cancelled — the 'Before restore' snapshot failed: disk full. No notes were changed.");
  });
});
