// The restore itself (R13.3–R13.5) with real git over a temp vault and a filesystem-backed Obsidian vault.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatTimestamp } from '../../src/snapshot/messages';
import { BEFORE_RESTORE_LABEL, Restorer, restoreSummary, type RestoreDone } from '../../src/snapshot/restore';
import type { ChangedFile, SnapshotInfo } from '../../src/snapshot/types';
import { FakeSnapshots, FsVault, gitWrapper, info, makeVault, readFile, realSnapshots, testLogger, writeFile } from './helpers';

const NFD_FOLDER = '한글 폴더'.normalize('NFD');
const NFD_NOTE = '노트.md'.normalize('NFD');
const KOREAN_PATH = '한글 폴더/노트.md'; // NFC, as the snapshot service reports it

async function setup(files: Record<string, string>) {
  const dir = makeVault(files);
  const snaps = realSnapshots(dir);
  const first = await snaps.service.snapshotNow({ kind: 'prompt', ai: 'claude', prompt: 'tidy up' });
  expect(first.status).toBe('committed');
  const [snapshot] = await snaps.service.list();
  return { dir, ...snaps, snapshot: snapshot! };
}

function restorer(vault: FsVault) {
  return new Restorer({ vault: vault.asVault(), log: testLogger() });
}

function byPath(files: ChangedFile[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.path, f.status]));
}

describe('restore (R13.3)', () => {
  it('takes a Before restore snapshot first, restores modified / deleted notes (nested, Korean NFD) and trashes created ones', async () => {
    const { dir, service, snapshot } = await setup({
      'A.md': 'A original',
      'B.md': 'B original',
      'deep/er/x.md': 'x original',
      'gone/folder/y.canvas': '{"nodes":[]}',
    });
    // A Korean folder + note stored decomposed on disk (as macOS Finder / sync tools do).
    mkdirSync(join(dir, NFD_FOLDER));
    writeFileSync(join(dir, NFD_FOLDER, NFD_NOTE), '한국어 원본');
    const withKorean = await service.snapshotNow({ kind: 'spawn', ai: 'agy' });
    expect(withKorean.status).toBe('committed');
    const [target] = await service.list();
    expect(target!.commit).not.toBe(snapshot.commit);

    writeFile(dir, 'A.md', 'A changed by AI');
    rmSync(join(dir, 'B.md'));
    writeFile(dir, 'deep/er/x.md', 'x changed');
    rmSync(join(dir, 'gone'), { recursive: true });
    writeFileSync(join(dir, NFD_FOLDER, NFD_NOTE), '한국어 수정됨');
    writeFile(dir, 'C.md', 'created by AI');
    writeFile(dir, 'new/nested/D.md', 'also created');
    const before = new FsVault(dir).notes();

    const files = await service.changedSince(target!.commit);
    expect(byPath(files)).toEqual({
      'A.md': 'modified',
      'B.md': 'deleted',
      'C.md': 'created',
      'deep/er/x.md': 'modified',
      'gone/folder/y.canvas': 'deleted',
      [KOREAN_PATH]: 'modified',
      'new/nested/D.md': 'created',
    });

    const vault = new FsVault(dir);
    expect(vault.getAbstractFileByPath(KOREAN_PATH)).not.toBeNull(); // indexed NFC, NFD on disk
    const done = (await restorer(vault).restore(service, { snapshot: target!, files })) as RestoreDone;
    expect(done.status).toBe('restored');
    expect(done.restored.sort()).toEqual(['A.md', 'B.md', 'deep/er/x.md', 'gone/folder/y.canvas', KOREAN_PATH].sort());
    expect(done.trashed.sort()).toEqual(['C.md', 'new/nested/D.md']);
    expect(done.failed).toEqual([]);

    // Files are back; created ones are in Obsidian's local trash (not deleted, not the system trash).
    expect(readFile(dir, 'A.md')).toBe('A original');
    expect(readFile(dir, 'B.md')).toBe('B original');
    expect(readFile(dir, 'deep/er/x.md')).toBe('x original');
    expect(readFile(dir, 'gone/folder/y.canvas')).toBe('{"nodes":[]}');
    expect(vault.trashed()).toEqual(['C.md', 'D.md']);
    expect(vault.calls.filter((c) => c.startsWith('trash:'))).toEqual(['trash:C.md:false', 'trash:new/nested/D.md:false']);
    expect(vault.calls).toContain('createFolder:gone');
    expect(vault.calls).toContain('createFolder:gone/folder');
    expect(vault.calls).toContain('createBinary:gone/folder/y.canvas');
    // The Korean note was written in place: one folder, one note, still decomposed on disk.
    expect(readdirSync(dir).filter((n) => n.normalize('NFC') === '한글 폴더')).toEqual([NFD_FOLDER]);
    expect(readdirSync(join(dir, NFD_FOLDER))).toEqual([NFD_NOTE]);
    expect(readFile(dir, `${NFD_FOLDER}/${NFD_NOTE}`)).toBe('한국어 원본');
    expect(vault.calls).toContain(`modifyBinary:${KOREAN_PATH}`);

    // The Before restore snapshot is the newest, holds the pre-restore notes, and the flag is set again.
    const [newest] = await service.list();
    expect(newest!.kind).toBe('restore');
    expect(newest!.subject.startsWith(`${BEFORE_RESTORE_LABEL} — `)).toBe(true);
    expect(done.undo).toEqual({ commit: newest!.commit, time: newest!.time, beforeRestore: true });
    expect((await service.readFileAt(newest!.commit, 'A.md')).toString()).toBe(before['A.md']);
    expect((await service.readFileAt(newest!.commit, 'C.md')).toString()).toBe('created by AI');
    expect((await service.readFileAt(newest!.commit, KOREAN_PATH)).toString()).toBe('한국어 수정됨');
    expect(service.hasChanges()).toBe(true);
    expect(await service.changedSince(target!.commit)).toEqual([]);

    const summary = restoreSummary(done, new Date(newest!.time));
    expect(summary).toBe(
      `AI Terminal: Restored 5 notes, moved 2 to trash. To undo, restore from 'Before restore' at ${formatTimestamp(new Date(newest!.time)).slice(11)}.`,
    );
  });

  it('R13.4: unticked files are left alone', async () => {
    const { dir, service, snapshot } = await setup({ 'A.md': 'A0', 'D.md': 'D0' });
    writeFile(dir, 'A.md', 'A1');
    writeFile(dir, 'D.md', 'D1 — my own edit');
    writeFile(dir, 'E.md', 'created, but unticked');
    const files = await service.changedSince(snapshot.commit);
    expect(files.map((f) => f.path)).toEqual(['A.md', 'D.md', 'E.md']);
    const vault = new FsVault(dir);
    const done = (await restorer(vault).restore(service, { snapshot, files: files.filter((f) => f.path === 'A.md') })) as RestoreDone;
    expect(done.restored).toEqual(['A.md']);
    expect(done.trashed).toEqual([]);
    expect(readFile(dir, 'A.md')).toBe('A0');
    expect(readFile(dir, 'D.md')).toBe('D1 — my own edit');
    expect(readFile(dir, 'E.md')).toBe('created, but unticked');
    expect(vault.calls).toEqual(['modifyBinary:A.md']);
  });

  it('R13.5: restoring from the Before restore snapshot returns the notes to their pre-restore state', async () => {
    const { dir, service, snapshot } = await setup({ 'A.md': 'A0', 'B.md': 'B0', 'keep.md': 'K', 'sub/S.md': 'S0' });
    writeFile(dir, 'A.md', 'A1');
    rmSync(join(dir, 'B.md'));
    writeFile(dir, 'C.md', 'C1');
    writeFile(dir, 'sub/new/N.md', 'N1');
    writeFile(dir, 'sub/S.md', 'S1');
    const vault = new FsVault(dir);
    const preRestore = vault.notes();

    const first = (await restorer(vault).restore(service, { snapshot, files: await service.changedSince(snapshot.commit) })) as RestoreDone;
    expect(first.status).toBe('restored');
    expect(vault.notes()).toEqual({ 'A.md': 'A0', 'B.md': 'B0', 'keep.md': 'K', 'sub/S.md': 'S0' });

    // The Before restore snapshot is listed (newest first) and undoes the restore.
    const listed = await service.list();
    expect(listed.map((s) => s.kind)).toEqual(['restore', 'prompt']);
    const beforeRestore = listed[0]!;
    const undoFiles = await service.changedSince(beforeRestore.commit);
    expect(byPath(undoFiles)).toEqual({ 'A.md': 'modified', 'B.md': 'created', 'C.md': 'deleted', 'sub/S.md': 'modified', 'sub/new/N.md': 'deleted' });
    const second = (await restorer(vault).restore(service, { snapshot: beforeRestore, files: undoFiles })) as RestoreDone;
    expect(second.failed).toEqual([]);
    expect(vault.notes()).toEqual(preRestore);
    // That restore took its own Before restore snapshot (holding the first restore's result).
    const after = await service.list();
    expect(after.map((s) => s.kind)).toEqual(['restore', 'restore', 'prompt']);
    expect((await service.readFileAt(after[0]!.commit, 'A.md')).toString()).toBe('A0');
  });

  it('never restores when the Before restore snapshot fails (R13.3) — nothing is touched', async () => {
    const { dir, storePath, snapshot } = await setup({ 'A.md': 'A0' });
    writeFile(dir, 'A.md', 'A1');
    writeFile(dir, 'C.md', 'C1');
    const failing = realSnapshots(dir, { storePath, gitPath: gitWrapper({ failOn: { commands: ['commit'], message: 'disk full' } }) });
    const files = await failing.service.changedSince(snapshot.commit);
    expect(files).toHaveLength(2);
    const vault = new FsVault(dir);
    const outcome = await restorer(vault).restore(failing.service, { snapshot, files });
    expect(outcome.status).toBe('aborted');
    expect(outcome.status === 'aborted' && outcome.reason).toMatch(/disk full/);
    expect(vault.calls).toEqual([]);
    expect(readFile(dir, 'A.md')).toBe('A1');
    expect(readFile(dir, 'C.md')).toBe('C1');
    expect((await failing.service.list()).map((s) => s.kind)).toEqual(['prompt']);
  });

  it('aborts on every non-commit outcome of the safety snapshot (disabled / pending / thrown)', async () => {
    const vault = new FsVault(makeVault({ 'A.md': 'x' }));
    const fake = new FakeSnapshots();
    const request = { snapshot: info('a'.repeat(40)), files: [{ path: 'A.md', status: 'modified' as const }] };
    const cases: Array<[() => Promise<never> | Promise<unknown>, RegExp]> = [
      [async () => ({ status: 'disabled', reason: 'git is missing' }), /git is missing/],
      [async () => ({ status: 'disabled' }), /not available/],
      [async () => ({ status: 'pending' }), /did not finish/],
      [async () => ({ status: 'unchanged' }), /current notes/],
      [async () => Promise.reject(new Error('boom')), /boom/],
    ];
    for (const [impl, reason] of cases) {
      fake.snapshotNow.mockImplementationOnce(impl as never);
      const outcome = await restorer(vault).restore(fake, request);
      expect(outcome.status).toBe('aborted');
      expect(outcome.status === 'aborted' && outcome.reason).toMatch(reason);
    }
    expect(fake.readFileAt).not.toHaveBeenCalled();
    expect(fake.markChanged).not.toHaveBeenCalled();
    expect(vault.calls).toEqual([]);
  });

  it('when the notes already match the newest snapshot, that snapshot is the undo point', async () => {
    const { dir, service, snapshot } = await setup({ 'A.md': 'A0' });
    writeFile(dir, 'A.md', 'A1');
    await service.snapshotNow({ kind: 'prompt', ai: 'claude', prompt: 'second' });
    const [head] = await service.list();
    const vault = new FsVault(dir);
    const done = (await restorer(vault).restore(service, { snapshot, files: await service.changedSince(snapshot.commit) })) as RestoreDone;
    expect(done.undo).toEqual({ commit: head!.commit, time: head!.time, beforeRestore: false });
    expect(readFile(dir, 'A.md')).toBe('A0');
    expect((await service.list()).length).toBe(2);
    expect(restoreSummary(done, new Date(head!.time))).toMatch(/Restored 1 note\. To undo, restore from the snapshot at \d\d:\d\d\.$/);
  });

  it('notes in dot-folders (not indexed by Obsidian) go through the adapter; a created note that is already gone is skipped', async () => {
    const { dir, service, snapshot } = await setup({ '.private/p.md': 'P0', 'a.md': 'a' });
    rmSync(join(dir, '.private'), { recursive: true });
    writeFile(dir, '.hidden/new.md', 'new');
    writeFile(dir, 'tmp.md', 'temporary');
    const files = await service.changedSince(snapshot.commit);
    expect(byPath(files)).toEqual({ '.private/p.md': 'deleted', '.hidden/new.md': 'created', 'tmp.md': 'created' });
    rmSync(join(dir, 'tmp.md')); // gone before the restore runs
    const vault = new FsVault(dir);
    const done = (await restorer(vault).restore(service, { snapshot, files })) as RestoreDone;
    expect(done.restored).toEqual(['.private/p.md']);
    expect(done.trashed).toEqual(['.hidden/new.md']);
    expect(done.alreadyGone).toEqual(['tmp.md']);
    expect(readFile(dir, '.private/p.md')).toBe('P0');
    expect(vault.trashed()).toEqual(['new.md']);
    expect(vault.calls).toEqual(['trashLocal:.hidden/new.md', 'mkdir:.private', 'writeBinary:.private/p.md']);
  });

  it('a file that cannot be written is reported; the others are still restored', async () => {
    const { dir, service, snapshot } = await setup({ 'A.md': 'A0', 'B.md': 'B0' });
    writeFile(dir, 'A.md', 'A1');
    writeFile(dir, 'B.md', 'B1');
    const vault = new FsVault(dir);
    vault.failOn.add('A.md');
    const done = (await restorer(vault).restore(service, { snapshot, files: await service.changedSince(snapshot.commit) })) as RestoreDone;
    expect(done.restored).toEqual(['B.md']);
    expect(done.failed).toEqual([{ path: 'A.md', reason: expect.stringMatching(/permission denied/) }]);
    expect(readFile(dir, 'B.md')).toBe('B0');
    expect(restoreSummary(done)).toMatch(/^AI Terminal: Restored 1 note\. Could not restore "A\.md": EACCES: permission denied.*\. To undo, restore from 'Before restore' at /);
  });

  it('a case-only rename (case-insensitive macOS names): the snapshot content comes back in place', async () => {
    const { dir, service, snapshot } = await setup({ 'Note.md': 'original' });
    rmSync(join(dir, 'Note.md'));
    writeFile(dir, 'note.md', 'renamed and edited');
    const files = await service.changedSince(snapshot.commit);
    expect(byPath(files)).toEqual({ 'Note.md': 'modified' });
    const vault = new FsVault(dir);
    const done = (await restorer(vault).restore(service, { snapshot, files })) as RestoreDone;
    expect(done.failed).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.endsWith('.md'))).toHaveLength(1);
    expect(readFile(dir, 'Note.md')).toBe('original');
    expect(vault.trashed()).toEqual([]);
  });

  it('one restore at a time', async () => {
    const vault = new FsVault(makeVault({ 'A.md': 'x' }));
    const fake = new FakeSnapshots();
    let release!: () => void;
    fake.snapshotNow.mockImplementationOnce(() => new Promise((r) => (release = () => r({ status: 'committed', commit: 'c'.repeat(40) }))));
    const r = restorer(vault);
    const request = { snapshot: info('a'.repeat(40)) as SnapshotInfo, files: [{ path: 'A.md', status: 'modified' as const }] };
    const first = r.restore(fake, request);
    expect(r.busy).toBe(true);
    expect(await r.restore(fake, request)).toEqual({ status: 'aborted', reason: 'another restore is still running' });
    release();
    expect((await first).status).toBe('restored');
    expect(r.busy).toBe(false);
  });
});
