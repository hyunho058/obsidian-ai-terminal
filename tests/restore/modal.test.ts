// @vitest-environment happy-dom
// The restore modal (R13.1, R13.2, R13.6) over a fake snapshots service, plus one full run over real git.
import type { App } from 'obsidian';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTimestamp } from '../../src/snapshot/messages';
import { abortedMessage, Restorer, type RestoreOutcome } from '../../src/snapshot/restore';
import { EMPTY_MESSAGE, GROUP_TITLES, RESTORE_TITLE, RestoreModal, type RestoreModalOptions } from '../../src/snapshot/restoreModal';
import type { ChangedFile, SnapshotInfo } from '../../src/snapshot/types';
import { App as MockApp, Modal } from '../mocks/obsidian';
import {
  FakeSnapshots,
  fakeSession,
  fakeSessions,
  FsVault,
  info,
  makeVault,
  readFile,
  realSnapshots,
  testLogger,
  writeFile,
  type FakeSession,
} from './helpers';

afterEach(() => {
  for (const m of [...Modal.open]) m.close();
});

const C = (n: number): string => n.toString(16).padStart(40, '0');
const T0 = new Date(2026, 9, 7, 14, 3).getTime();

function stubRestorer(outcome: RestoreOutcome | (() => Promise<RestoreOutcome>)) {
  const calls: Array<{ files: ChangedFile[]; snapshot: SnapshotInfo }> = [];
  const restorer = {
    busy: false,
    restore: vi.fn(async (_s: unknown, req: { files: ChangedFile[]; snapshot: SnapshotInfo }) => {
      calls.push({ files: [...req.files], snapshot: req.snapshot });
      return typeof outcome === 'function' ? outcome() : outcome;
    }),
  };
  return { restorer: restorer as unknown as Restorer, spy: restorer.restore, calls };
}

const DONE: RestoreOutcome = { status: 'restored', restored: ['A.md'], trashed: ['C.md'], alreadyGone: [], failed: [], undo: { commit: C(99), time: T0, beforeRestore: true } };

interface OpenOptions extends Partial<Omit<RestoreModalOptions, 'sessions'>> {
  fake?: FakeSnapshots;
  panels?: FakeSession[];
  stopMs?: number;
  outcome?: RestoreOutcome | (() => Promise<RestoreOutcome>);
  app?: MockApp;
}

function openModal(o: OpenOptions = {}) {
  const { fake: given, panels, stopMs, outcome, app, ...rest } = o;
  const fake = given ?? new FakeSnapshots();
  const sessions = fakeSessions(panels ?? [], stopMs ?? 0);
  const stub = stubRestorer(outcome ?? DONE);
  const notices: string[] = [];
  const modal = new RestoreModal((app ?? new MockApp('/vault')) as unknown as App, {
    snapshots: fake,
    sessions: () => sessions.service,
    restorer: stub.restorer,
    log: testLogger(),
    notify: (m) => void notices.push(m),
    ...rest,
  });
  modal.open();
  const content = (modal as unknown as Modal).contentEl as HTMLElement;
  return { modal, fake, sessions, stub, notices, content };
}

const rows = (content: HTMLElement) => [...content.querySelectorAll<HTMLElement>('.ai-terminal-restore-snapshot')];
const rowText = (row: HTMLElement) => ({
  name: row.querySelector('.setting-item-name')!.textContent,
  what: row.querySelector('.ai-terminal-restore-what')!.textContent,
  count: row.querySelector('.ai-terminal-restore-count')!.textContent,
});
const buttons = (content: HTMLElement) => [...content.querySelectorAll<HTMLButtonElement>('button')];
const button = (content: HTMLElement, text: string | RegExp) => {
  const b = buttons(content).find((x) => (typeof text === 'string' ? x.textContent === text : text.test(x.textContent ?? '')));
  if (!b) throw new Error(`no button ${text}; have ${buttons(content).map((x) => x.textContent).join(' | ')}`);
  return b;
};
const boxes = (content: HTMLElement) => [...content.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
const toggle = (box: HTMLInputElement) => {
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change'));
};

describe('step 1 — snapshot list (R13.1)', () => {
  it('lists snapshots newest first with time, AI, prompt excerpt or kind label, and files changed since', async () => {
    const fake = new FakeSnapshots();
    fake.infos = [
      info(C(1), { time: T0 + 4 * 60_000, kind: 'restore', subject: 'Before restore — x' }),
      info(C(2), { time: T0 + 3 * 60_000, kind: 'prompt', ai: 'claude', promptExcerpt: 'make this shorter' }),
      info(C(3), { time: T0 + 2 * 60_000, kind: 'prompt', ai: 'agy' }),
      info(C(4), { time: T0 + 60_000, kind: 'spawn', ai: 'claude' }),
      info(C(5), { time: T0, kind: 'first' }),
      info(C(6), { time: T0 - 60_000, kind: 'unknown', subject: 'Something else — 2026-10-07 14:02' }),
    ];
    fake.changes.set(C(2), [{ path: 'a.md', status: 'modified' }]);
    fake.changes.set(C(3), [
      { path: 'a.md', status: 'modified' },
      { path: 'b.md', status: 'created' },
    ]);
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    const { content, modal } = openModal({ fake });
    expect((modal as unknown as Modal).titleEl.textContent).toBe(RESTORE_TITLE);
    await vi.waitFor(() => expect(rows(content)).toHaveLength(6));
    const t = (ms: number) => formatTimestamp(new Date(ms));
    // Counts show "…" until computed.
    expect(rows(content).map(rowText)).toEqual([
      { name: `${t(T0 + 240_000)} · —`, what: 'before restore', count: '…' },
      { name: `${t(T0 + 180_000)} · Claude Code`, what: '"make this shorter"', count: '…' },
      { name: `${t(T0 + 120_000)} · Antigravity`, what: 'before input', count: '…' },
      { name: `${t(T0 + 60_000)} · Claude Code`, what: 'session start', count: '…' },
      { name: `${t(T0)} · —`, what: 'first snapshot', count: '…' },
      { name: `${t(T0 - 60_000)} · —`, what: 'Something else', count: '…' },
    ]);
    expect(t(T0)).toBe('2026-10-07 14:03');
    open();
    await vi.waitFor(() => expect(rows(content).map((r) => rowText(r).count)).toEqual([
      'no changes since',
      '1 file changed since',
      '2 files changed since',
      'no changes since',
      'no changes since',
      'no changes since',
    ]));
    // One changedSinceMany call for all rows of a short list.
    expect(fake.changedSinceMany).toHaveBeenCalledTimes(1);
    expect(fake.changedSinceMany.mock.calls[0]![0]).toEqual([C(1), C(2), C(3), C(4), C(5), C(6)]);
  });

  it('counts long lists progressively, only for shown rows; "Show older snapshots" pages in more', async () => {
    const fake = new FakeSnapshots();
    fake.infos = Array.from({ length: 30 }, (_, i) => info(C(i + 1), { time: T0 - i * 60_000 }));
    const { content } = openModal({ fake, pageSize: 20, countBatch: { first: 5, next: 10 } });
    await vi.waitFor(() => expect(fake.changedSinceMany).toHaveBeenCalledTimes(3));
    expect(rows(content)).toHaveLength(20);
    expect(fake.changedSinceMany.mock.calls.map((c) => c[0].length)).toEqual([5, 10, 5]);
    expect(fake.changedSinceMany.mock.calls.flatMap((c) => c[0])).toEqual(fake.infos.slice(0, 20).map((s) => s.commit));
    await vi.waitFor(() => expect(rows(content).every((r) => rowText(r).count === 'no changes since')).toBe(true));
    button(content, 'Show older snapshots').click();
    expect(rows(content)).toHaveLength(30);
    expect(buttons(content).some((b) => b.textContent === 'Show older snapshots')).toBe(false);
    await vi.waitFor(() => expect(fake.changedSinceMany).toHaveBeenCalledTimes(4));
    expect(fake.changedSinceMany.mock.calls[3]![0]).toEqual(fake.infos.slice(20).map((s) => s.commit));
  });

  it('shows "?" when counting fails', async () => {
    const fake = new FakeSnapshots();
    fake.infos = [info(C(1)), info(C(2))];
    fake.countError = new Error('index.lock');
    const { content } = openModal({ fake });
    await vi.waitFor(() => expect(rows(content).map((r) => rowText(r).count)).toEqual(['?', '?']));
    expect(rows(content)[0]!.querySelector('.ai-terminal-restore-count')!.getAttribute('title')).toBe('index.lock');
  });

  it('empty state: "No snapshots yet" with a hint that depends on the setting', async () => {
    for (const [setting, hint] of [
      [true, /before each message you send/],
      [false, /Turn on "AI session snapshots" in the AI Terminal settings/],
      [null, /Turn on "AI session snapshots" in the AI Terminal settings/],
    ] as const) {
      const { content, modal, fake } = openModal({ snapshotsSetting: () => setting });
      await vi.waitFor(() => expect(content.textContent).toContain(EMPTY_MESSAGE));
      expect(content.querySelector('.ai-terminal-restore-empty')!.textContent).toMatch(hint);
      expect(fake.changedSinceMany).not.toHaveBeenCalled();
      button(content, 'Close').click();
      expect(modal.isClosed).toBe(true);
    }
  });

  it('a list error is shown in the modal', async () => {
    const fake = new FakeSnapshots();
    fake.listError = new Error('git is not available');
    const { content, modal } = openModal({ fake });
    await vi.waitFor(() => expect(modal.step).toBe('error'));
    expect(content.textContent).toContain('Could not read the snapshots: git is not available');
  });
});

describe('step 2 — changed files (R13.2, R13.4)', () => {
  const FILES: ChangedFile[] = [
    { path: 'A.md', status: 'modified' },
    { path: 'B.md', status: 'deleted' },
    { path: 'C.md', status: 'created' },
    { path: 'sub/한글.md', status: 'modified' },
  ];

  async function pickFirst(o: OpenOptions = {}) {
    const fake = o.fake ?? new FakeSnapshots();
    if (fake.infos.length === 0) fake.infos = [info(C(1), { ai: 'claude', promptExcerpt: 'fix links' }), info(C(2))];
    if (!fake.changes.has(C(1))) fake.changes.set(C(1), FILES);
    const opened = openModal({ ...o, fake });
    await vi.waitFor(() => expect(rows(opened.content)).toHaveLength(fake.infos.length));
    rows(opened.content)[0]!.click();
    await vi.waitFor(() => expect(boxes(opened.content).length).toBeGreaterThan(0));
    return opened;
  }

  it('lists the files grouped by status, all ticked; untick / select none / select all; Back returns to the list', async () => {
    const { content, modal, fake } = await pickFirst();
    expect(fake.changedSince).toHaveBeenCalledWith(C(1));
    expect(content.querySelector('.ai-terminal-restore-header')!.textContent).toContain('Claude Code · "fix links"');
    expect([...content.querySelectorAll('h4')].map((h) => h.textContent)).toEqual([
      `${GROUP_TITLES.modified} (2)`,
      `${GROUP_TITLES.deleted} (1)`,
      `${GROUP_TITLES.created} (1)`,
    ]);
    expect(GROUP_TITLES.created).toMatch(/will move to trash/);
    expect(boxes(content).map((b) => [b.getAttribute('data-path'), b.checked])).toEqual([
      ['A.md', true],
      ['sub/한글.md', true],
      ['B.md', true],
      ['C.md', true],
    ]);
    const restore = button(content, /^Restore/);
    expect(restore.textContent).toBe('Restore 4 notes');
    expect(restore.disabled).toBe(false);

    toggle(boxes(content)[0]!);
    expect(modal.chosenFiles().map((f) => f.path)).toEqual(['B.md', 'C.md', 'sub/한글.md']);
    expect(restore.textContent).toBe('Restore 3 notes');

    button(content, 'Select none').click();
    expect(boxes(content).every((b) => !b.checked)).toBe(true);
    expect(restore.disabled).toBe(true);
    restore.click();
    expect(modal.step).toBe('files');

    button(content, 'Select all').click();
    expect(boxes(content).every((b) => b.checked)).toBe(true);
    expect(restore.textContent).toBe('Restore 4 notes');

    button(content, 'Back').click();
    expect(modal.step).toBe('list');
    expect(rows(content)).toHaveLength(2);
    expect(rowText(rows(content)[0]!).count).toBe('4 files changed since');
  });

  it('nothing to restore when the notes match the snapshot', async () => {
    const fake = new FakeSnapshots();
    fake.infos = [info(C(1))];
    fake.changes.set(C(1), []);
    const { content } = openModal({ fake });
    await vi.waitFor(() => expect(rows(content)).toHaveLength(1));
    rows(content)[0]!.click();
    await vi.waitFor(() => expect(content.textContent).toContain('Nothing to restore — your notes match this snapshot.'));
    expect(boxes(content)).toHaveLength(0);
  });

  it('without running AI panels the restore runs at once with only the ticked files; the summary is shown and the modal closes', async () => {
    const sessions = [fakeSession('shell', true), fakeSession('claude', false)];
    const { content, modal, stub, notices } = await pickFirst({ panels: sessions });
    toggle(boxes(content)[1]!); // untick sub/한글.md
    button(content, /^Restore/).click();
    await vi.waitFor(() => expect(modal.isClosed).toBe(true));
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.snapshot.commit).toBe(C(1));
    expect(stub.calls[0]!.files.map((f) => f.path)).toEqual(['A.md', 'B.md', 'C.md']);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^AI Terminal: Restored 1 note, moved 1 to trash\. To undo, restore from 'Before restore' at (\d{4}-\d\d-\d\d )?\d\d:\d\d\.$/);
  });

  describe('running AI panels (R13.6)', () => {
    const running = () => [fakeSession('claude', true, 'p-claude'), fakeSession('agy', true, 'p-agy'), fakeSession('shell', true, 'p-shell'), fakeSession('claude', false, 'p-old')];

    it('warns with [Stop them and restore] [Restore anyway] [Cancel]; Cancel goes back with the selection kept', async () => {
      const { content, modal, stub, sessions } = await pickFirst({ panels: running() });
      toggle(boxes(content)[0]!);
      button(content, /^Restore/).click();
      expect(modal.step).toBe('running');
      expect(content.textContent).toContain('2 AI panels are running — they may overwrite restored notes and still remember the old content.');
      expect([...content.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Claude Code', 'Antigravity']);
      expect(buttons(content).map((b) => b.textContent)).toEqual(['Stop them and restore', 'Restore anyway', 'Cancel']);
      button(content, 'Cancel').click();
      expect(modal.step).toBe('files');
      expect(boxes(content).map((b) => b.checked)).toEqual([false, true, true, true]);
      expect(stub.spy).not.toHaveBeenCalled();
      expect(sessions.stop).not.toHaveBeenCalled();
    });

    it('Restore anyway restores without stopping anything', async () => {
      const { content, modal, stub, sessions } = await pickFirst({ panels: running() });
      button(content, /^Restore/).click();
      button(content, 'Restore anyway').click();
      await vi.waitFor(() => expect(modal.isClosed).toBe(true));
      expect(stub.spy).toHaveBeenCalledTimes(1);
      expect(sessions.stop).not.toHaveBeenCalled();
    });

    it('Stop them and restore stops both AI sessions (and waits for them) before restoring', async () => {
      const order: string[] = [];
      const { content, modal, stub, sessions } = await pickFirst({
        panels: running(),
        stopMs: 50,
        outcome: async () => {
          order.push('restore');
          return DONE;
        },
      });
      sessions.stop.mockImplementation(async (id: string, reason: string) => {
        order.push(`stop ${id} ${reason}`);
        await new Promise((r) => setTimeout(r, 50));
        order.push(`stopped ${id}`);
      });
      button(content, /^Restore/).click();
      button(content, 'Stop them and restore').click();
      expect(content.textContent).toContain('Stopping 2 AI panels…');
      await vi.waitFor(() => expect(modal.isClosed).toBe(true));
      expect(order).toEqual(['stop p-claude restore', 'stop p-agy restore', 'stopped p-claude', 'stopped p-agy', 'restore']);
      expect(stub.spy).toHaveBeenCalledTimes(1);
    });

    it('a session that does not stop in time does not block the restore forever', async () => {
      const { content, modal, stub } = await pickFirst({ panels: [fakeSession('claude', true)], stopMs: Infinity, stopWaitMs: 30 });
      button(content, /^Restore/).click();
      expect(content.textContent).toContain('1 AI panel is running — it may overwrite restored notes');
      button(content, 'Stop them and restore').click();
      await vi.waitFor(() => expect(modal.isClosed).toBe(true));
      expect(stub.spy).toHaveBeenCalledTimes(1);
    });
  });

  it('a failed Before restore snapshot cancels the restore with a clear message', async () => {
    const { content, modal, notices } = await pickFirst({ outcome: { status: 'aborted', reason: 'disk full' } });
    button(content, /^Restore/).click();
    await vi.waitFor(() => expect(modal.step).toBe('aborted'));
    expect(notices).toEqual([abortedMessage('disk full')]);
    expect(notices[0]).toBe("AI Terminal: Restore cancelled — the 'Before restore' snapshot failed: disk full. No notes were changed.");
    expect(content.textContent).toContain("Restore cancelled — the 'Before restore' snapshot failed: disk full. No notes were changed.");
    button(content, 'Back').click();
    expect(modal.step).toBe('files');
    expect(boxes(content)).toHaveLength(4);
  });

  it('a second restore while one runs is refused', async () => {
    const { content, stub, notices } = await pickFirst();
    (stub.restorer as unknown as { busy: boolean }).busy = true;
    button(content, /^Restore/).click();
    await vi.waitFor(() => expect(notices).toEqual(['AI Terminal: a restore is already running.']));
    expect(stub.spy).not.toHaveBeenCalled();
  });
});

describe('popout windows', () => {
  it('opens in the window of the active leaf', () => {
    const g = globalThis as { activeWindow?: unknown; activeDocument?: unknown };
    const main = { closed: false, document: { name: 'main' } };
    const popout = { closed: false, document: { name: 'popout' } };
    const app = new MockApp('/vault');
    (app.workspace as unknown as { getActiveViewOfType: unknown }).getActiveViewOfType = () => ({ containerEl: { ownerDocument: { defaultView: popout } } });
    const prev = { w: g.activeWindow, d: g.activeDocument };
    g.activeWindow = main;
    g.activeDocument = main.document;
    try {
      const modal = new RestoreModal(app as unknown as App, { snapshots: new FakeSnapshots(), sessions: () => undefined, restorer: stubRestorer(DONE).restorer, log: testLogger() });
      const seen: unknown[] = [];
      modal.open = () => void seen.push(g.activeWindow, g.activeDocument);
      modal.openInActiveWindow();
      expect(seen).toEqual([popout, popout.document]);
      expect(g.activeWindow).toBe(main);
    } finally {
      g.activeWindow = prev.w;
      g.activeDocument = prev.d;
    }
  });
});

describe('full run over real git (R13.3, R13.5)', () => {
  it('pick → restore → the Before restore snapshot appears in the list → restoring it undoes the restore', async () => {
    const dir = makeVault({ 'A.md': 'A0', 'B.md': 'B0', 'notes/한글.md': '원본' });
    const { service } = realSnapshots(dir);
    await service.snapshotNow({ kind: 'prompt', ai: 'claude', prompt: 'rewrite everything' });
    writeFile(dir, 'A.md', 'A1');
    rmSync(join(dir, 'B.md'));
    writeFile(dir, 'notes/한글.md', '수정');
    writeFile(dir, 'C.md', 'C1');
    const vault = new FsVault(dir);
    const preRestore = vault.notes();
    const restorer = new Restorer({ vault: vault.asVault(), log: testLogger() });
    const notices: string[] = [];
    const open = () => {
      const modal = new RestoreModal(new MockApp(dir) as unknown as App, {
        snapshots: service,
        sessions: () => undefined,
        restorer,
        log: testLogger(),
        notify: (m) => void notices.push(m),
      });
      modal.open();
      return { modal, content: (modal as unknown as Modal).contentEl as HTMLElement };
    };

    let { modal, content } = open();
    await vi.waitFor(() => expect(rows(content).map((r) => rowText(r).count)).toEqual(['4 files changed since']));
    expect(rowText(rows(content)[0]!).what).toBe('"rewrite everything"');
    rows(content)[0]!.click();
    await vi.waitFor(() => expect(boxes(content)).toHaveLength(4));
    button(content, 'Restore 4 notes').click();
    await vi.waitFor(() => expect(modal.isClosed).toBe(true), { timeout: 10_000 });
    expect(notices[0]).toMatch(/^AI Terminal: Restored 3 notes, moved 1 to trash\. To undo, restore from 'Before restore' at \d\d:\d\d\.$/);
    expect(vault.notes()).toEqual({ 'A.md': 'A0', 'B.md': 'B0', 'notes/한글.md': '원본' });
    expect(readFile(dir, '.trash/C.md')).toBe('C1');

    ({ modal, content } = open());
    await vi.waitFor(() => expect(rows(content)).toHaveLength(2));
    expect(rowText(rows(content)[0]!).what).toBe('before restore');
    await vi.waitFor(() => expect(rowText(rows(content)[0]!).count).toBe('4 files changed since'));
    rows(content)[0]!.click();
    await vi.waitFor(() => expect(boxes(content)).toHaveLength(4));
    button(content, 'Restore 4 notes').click();
    await vi.waitFor(() => expect(modal.isClosed).toBe(true), { timeout: 10_000 });
    expect(vault.notes()).toEqual(preRestore);
  });
});
