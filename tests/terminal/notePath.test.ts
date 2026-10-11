// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileId } from '../../src/core';
import {
  NO_NOTE_NOTICE,
  NO_TERMINAL_NOTICE,
  notePathText,
  notRunningNotice,
  SEND_NOTE_PATH_COMMAND,
} from '../../src/terminal/notePath';
import { TerminalView } from '../../src/terminal/TerminalView';
import { MarkdownView, Notice, TFile, type WorkspaceLeaf } from '../mocks/obsidian';
import type { FakePtyProcess } from '../session/helpers';
import { waitFor } from '../session/helpers';
import { makeViewHarness, type ViewHarness } from './helpers';

const NOTE = 'IELTS/Grammar/21.Adjectives + Characters.md';

const leafOf = (view: TerminalView): WorkspaceLeaf => view.leaf as unknown as WorkspaceLeaf;

let h: ViewHarness | null = null;
afterEach(() => {
  h?.runtime.unload();
  h = null;
  Notice.clear();
  vi.restoreAllMocks();
});

describe('notePathText', () => {
  it.each<[ProfileId, string, string]>([
    ['claude', 'notes/plain.md', ' @notes/plain.md '],
    ['claude', NOTE, ` @"${NOTE}" `],
    ['agy', 'notes/plain.md', ' @notes/plain.md '],
    ['agy', NOTE, ` @"${NOTE}" `],
    ['claude', '노트/문법.md', ' @노트/문법.md '],
    ['shell', 'notes/plain.md', ' notes/plain.md '],
    ['shell', NOTE, ` '${NOTE}' `],
    ['shell', "it's a note.md", ` 'it'\\''s a note.md' `],
    ['shell', '노트/문법.md', ` '노트/문법.md' `],
  ])('%s, %j → %j', (profile, path, expected) => {
    expect(notePathText(profile, path)).toBe(expected);
  });
});

describe('"Send note path to terminal" command', () => {
  async function setup() {
    h = await makeViewHarness();
    const cmd = h.plugin.commands.find((c) => c.id === `obsidian-ai-terminal:${SEND_NOTE_PATH_COMMAND.id}`);
    if (!cmd) throw new Error('command not registered');
    return { harness: h, run: () => cmd.callback!() };
  }

  /** A note leaf in the main area, focused like a click into the note. */
  function focusNote(harness: ViewHarness, path: string): WorkspaceLeaf {
    const leaf = harness.app.workspace.getLeaf('tab');
    const view = new MarkdownView(leaf);
    view.file = new TFile(path);
    leaf.view = view;
    harness.app.workspace.setActiveLeaf(leaf, { focus: true });
    return leaf;
  }

  async function openRunning(harness: ViewHarness, profile: ProfileId): Promise<{ view: TerminalView; proc: FakePtyProcess }> {
    const count = harness.pty.spawned.length;
    const view = (await harness.terminals.open(profile))!;
    await waitFor(() => harness.pty.spawned.length === count + 1 && view.session?.state === 'running');
    return { view, proc: harness.pty.spawned[count]! };
  }

  it('is registered with its palette name', async () => {
    const { harness } = await setup();
    const cmd = harness.plugin.commands.find((c) => c.name === 'Send note path to terminal');
    expect(cmd?.id).toBe('obsidian-ai-terminal:send-note-path');
    expect(cmd?.icon).toBe('at-sign');
  });

  it('types the active note as an @ mention into the last focused AI panel, unsent, and focuses it', async () => {
    const { harness, run } = await setup();
    const { view, proc } = await openRunning(harness, 'claude');
    focusNote(harness, NOTE);
    const focus = vi.spyOn(TerminalView.prototype, 'focusTerminal');
    run();
    await waitFor(() => proc.input().includes('@'));
    expect(proc.input()).toBe(` @"${NOTE}" `);
    expect(proc.input()).not.toMatch(/[\r\n]/);
    expect(harness.app.workspace.activeLeaf).toBe(leafOf(view));
    expect(focus).toHaveBeenCalled();
    expect(Notice.shown).toHaveLength(0);
  });

  it('uses bracketed paste when the program asked for it, so the text is not read as typed keys', async () => {
    const { harness, run } = await setup();
    const { view, proc } = await openRunning(harness, 'agy');
    proc.emitData('\x1b[?2004h');
    await new Promise<void>((r) => view.terminal!.write('', r));
    focusNote(harness, 'notes/plain.md');
    run();
    await waitFor(() => proc.input().length > 0);
    expect(proc.input()).toBe('\x1b[200~ @notes/plain.md \x1b[201~');
  });

  it('works while the terminal itself is focused (Obsidian still names the last note)', async () => {
    const { harness, run } = await setup();
    focusNote(harness, 'notes/plain.md');
    const { view, proc } = await openRunning(harness, 'claude');
    expect(harness.app.workspace.activeLeaf).toBe(leafOf(view));
    // Real Obsidian's getActiveFile falls back to the last note editor; the mock only looks at the active leaf.
    vi.spyOn(harness.app.workspace, 'getActiveFile').mockReturnValue(new TFile('notes/plain.md'));
    run();
    await waitFor(() => proc.input().length > 0);
    expect(proc.input()).toBe(' @notes/plain.md ');
  });

  it('picks the focused terminal, else the last focused one, else the newest one', async () => {
    const { harness, run } = await setup();
    const claude = await openRunning(harness, 'claude');
    const agy = await openRunning(harness, 'agy');
    const shell = await openRunning(harness, 'shell');
    // Last focused: agy (shell was opened last, but the user then clicked agy).
    harness.app.workspace.setActiveLeaf(leafOf(agy.view), { focus: true });
    focusNote(harness, 'a.md');
    run();
    await waitFor(() => agy.proc.input().length > 0);
    expect(agy.proc.input()).toBe(' @a.md ');
    expect(claude.proc.input()).toBe('');
    expect(shell.proc.input()).toBe('');

    // The focused terminal wins.
    const file = vi.spyOn(harness.app.workspace, 'getActiveFile').mockReturnValue(new TFile('b c.md'));
    harness.app.workspace.setActiveLeaf(leafOf(shell.view), { focus: true });
    run();
    await waitFor(() => shell.proc.input().length > 0);
    expect(shell.proc.input()).toBe(" 'b c.md' ");
    file.mockRestore();

    // The last focused panel closed (shell) → the newest open one (agy).
    shell.view.leaf.detach();
    focusNote(harness, 'd.md');
    const before = agy.proc.input();
    run();
    await waitFor(() => agy.proc.input() !== before);
    expect(agy.proc.input().slice(before.length)).toBe(' @d.md ');
    expect(claude.proc.input()).toBe('');
  });

  it('without a note, a terminal, or a running program: a notice and nothing typed', async () => {
    const { harness, run } = await setup();
    focusNote(harness, 'a.md');
    run();
    await waitFor(() => Notice.shown.length === 1);
    expect(Notice.shown[0]!.message).toBe(NO_TERMINAL_NOTICE);

    const { view, proc } = await openRunning(harness, 'claude');
    vi.spyOn(harness.app.workspace, 'getActiveFile').mockReturnValue(null);
    run();
    await waitFor(() => Notice.shown.length === 2);
    expect(Notice.shown[1]!.message).toBe(NO_NOTE_NOTICE);
    vi.restoreAllMocks();

    proc.exit(0);
    await waitFor(() => view.session?.isRunning === false);
    focusNote(harness, 'a.md');
    run();
    await waitFor(() => Notice.shown.length === 3);
    expect(Notice.shown[2]!.message).toBe(notRunningNotice('Claude Code'));
    expect(proc.input()).toBe('');
  });
});
