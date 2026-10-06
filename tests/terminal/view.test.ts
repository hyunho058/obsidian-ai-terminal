// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_VIEW_TYPE } from '../../src/core';
import { WorkspaceLeaf } from '../mocks/obsidian';
import { FakeSink, sleep, waitFor } from '../session/helpers';
import { bufferText, FAST, flushTerm, makeViewHarness, stubFit, viewOf, type ViewHarness } from './helpers';

let h: ViewHarness | null = null;

beforeEach(() => {
  document.body.className = '';
});

afterEach(() => {
  h?.runtime.unload();
  h = null;
  vi.restoreAllMocks();
});

async function setup(opts: { gated?: boolean } = {}): Promise<ViewHarness> {
  h = await makeViewHarness(opts);
  return h;
}

async function openRunning(harness: ViewHarness, profile: 'claude' | 'agy' | 'shell' = 'claude') {
  const view = (await harness.terminals.open(profile))!;
  await waitFor(() => view.session?.state === 'running');
  return { view, proc: harness.pty.last, leaf: view.leaf as unknown as WorkspaceLeaf };
}

describe('TerminalView', () => {
  it('stores {profile, panelId, sessionId} in its view state and shows the profile title / icon (D4, D9)', async () => {
    const harness = await setup();
    harness.ctx.spawn.add('sid', (c) => (c.profile === 'claude' ? { sessionId: c.sessionId ?? 'uuid-1' } : undefined));
    const { view } = await openRunning(harness, 'claude');
    expect(view.getViewType()).toBe(TERMINAL_VIEW_TYPE);
    expect(view.getDisplayText()).toBe('Claude Code');
    expect(view.getIcon()).toBe('sparkles');
    const state = view.getState();
    expect(state).toEqual({ profile: 'claude', panelId: view.panelId, sessionId: 'uuid-1' });
    expect(state.panelId).toMatch(/^[0-9a-f-]{36}$/);
    // The contributor's session id reached the view and Obsidian was asked to save the layout (R5.3 path).
    expect(harness.app.workspace.layoutSaveRequests).toBeGreaterThan(0);
    expect(view.label).toBe('Claude Code');
    expect(view.isRunning()).toBe(true);
  });

  it('restores a saved panel with phase "restore" and its session id (R5.8 / R5.11 plumbing)', async () => {
    const harness = await setup();
    const phases: Array<[string, string | undefined]> = [];
    harness.ctx.sessionEvents.beforeSpawn((c) => {
      phases.push([c.phase, c.sessionId]);
    });
    const leaf = new WorkspaceLeaf(harness.app, 'right');
    harness.app.workspace.leaves.push(leaf);
    await leaf.setViewState({ type: TERMINAL_VIEW_TYPE, state: { profile: 'claude', panelId: 'saved-panel', sessionId: 'conv-1' } });
    const view = viewOf(leaf);
    await waitFor(() => view.session?.state === 'running');
    expect(phases).toEqual([['restore', 'conv-1']]);
    expect(view.getState()).toEqual({ profile: 'claude', panelId: 'saved-panel', sessionId: 'conv-1' });
    // A shell restores fresh (no session id).
    const shellLeaf = new WorkspaceLeaf(harness.app, 'right');
    await shellLeaf.setViewState({ type: TERMINAL_VIEW_TYPE, state: { profile: 'shell', panelId: 'saved-shell' } });
    await waitFor(() => viewOf(shellLeaf).session?.state === 'running');
    expect(phases[1]).toEqual(['restore', undefined]);
    expect(harness.pty.last.command).toBe(harness.ctx.settings.profiles.shell.command);
  });

  it('a view state without panelId gets a fresh one and starts as a new panel', async () => {
    const harness = await setup();
    const leaf = new WorkspaceLeaf(harness.app, 'main');
    await leaf.setViewState({ type: TERMINAL_VIEW_TYPE, state: { profile: 'agy' } });
    const view = viewOf(leaf);
    await waitFor(() => view.session?.state === 'running');
    expect(view.panelId).toMatch(/^[0-9a-f-]{36}$/);
    expect(harness.events.find((e) => e[0] === 'session:spawning')![1]).toMatchObject({ phase: 'new', profile: 'agy' });
  });

  it('nothing spawns for a leaf whose view was never opened (deferred tabs, R5.9)', async () => {
    const harness = await setup();
    const leaf = new WorkspaceLeaf(harness.app, 'main');
    harness.app.workspace.leaves.push(leaf);
    await sleep(20);
    expect(harness.pty.calls).toHaveLength(0);
    expect(harness.sessions.list()).toEqual([]);
    await leaf.setViewState({ type: TERMINAL_VIEW_TYPE, state: { profile: 'shell', panelId: 'bg' } });
    await waitFor(() => harness.pty.calls.length === 1);
  });

  it('sizes the program to the panel and follows panel resizes (R1.8, R6.4)', async () => {
    const harness = await setup();
    const fit = stubFit(100, 30);
    const { view, proc } = await openRunning(harness);
    expect(harness.pty.calls[0]).toMatchObject({ cols: 100, rows: 30 });
    fit.mockReturnValue({ cols: 120, rows: 40 });
    const t0 = Date.now();
    view.onResize();
    await waitFor(() => proc.resizes.length > 0);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(proc.resizes).toEqual([[120, 40]]);
    expect([view.terminal!.cols, view.terminal!.rows]).toEqual([120, 40]);
    expect(harness.sessions.mirrorOf(view.panelId!)).toMatchObject({ cols: 120, rows: 40 });
  });

  it('sends typed input to the program and shows its output (R1.5)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'shell');
    view.terminal!.input('ls\r');
    expect(proc.input()).toBe('ls\r');
    proc.emitData('한글 😀 \x1b[38;2;255;0;0mred\x1b[0m\r\n');
    await sleep(5);
    await flushTerm(view);
    expect(bufferText(view)).toContain('한글 😀 red');
    // Unicode 11 widths: Hangul and emoji are two cells wide (R2.7).
    const line = view.terminal!.buffer.active.getLine(0)!;
    expect(line.getCell(0)!.getWidth()).toBe(2);
    expect(line.getCell(2)!.getChars()).toBe('글');
    expect(line.getCell(5)!.getWidth()).toBe(2);
    expect(line.getCell(8)!.getChars()).toBe('r');
    expect(line.getCell(8)!.isFgRGB()).toBe(true);
  });

  it('shows the exit prompt in the panel and restarts on Enter (R5.1, R5.2)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'shell');
    proc.emitData('last answer\r\n');
    proc.exit(0);
    await waitFor(() => view.session?.state === 'exited');
    await waitFor(() => bufferText(view).includes('[Process exited with code 0 — press Enter to restart]'));
    expect(bufferText(view)).toContain('last answer');
    expect(view.isRunning()).toBe(false);
    view.terminal!.input('\r');
    await waitFor(() => harness.pty.spawned.length === 2 && view.session?.state === 'running');
    expect(view.session?.panelId).toBe(view.panelId);
  });

  it('routes key events through ctx.keyboard.dispatchKey with the panel handle (T4 seam)', async () => {
    const harness = await setup();
    const seen: Array<[string, string, string]> = [];
    harness.ctx.keyboard.onKey((ev, panel) => {
      seen.push([ev.type, ev.key, panel.panelId]);
      return ev.key === 'q';
    });
    const { view, proc } = await openRunning(harness, 'shell');
    const textarea = view.terminal!.textarea!;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', keyCode: 81, bubbles: true }));
    expect(seen[0]).toEqual(['keydown', 'q', view.panelId]);
    expect(proc.input()).toBe('');
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    expect(seen.some(([, key]) => key === 'Enter')).toBe(true);
    expect(proc.input()).toBe('\r');
  });

  it('follows the Obsidian theme on css-change without restarting (R2.8)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'shell');
    const light = view.terminal!.options.theme!;
    document.body.classList.add('theme-dark');
    harness.app.workspace.trigger('css-change');
    const dark = view.terminal!.options.theme!;
    expect(dark.background).not.toBe(light.background);
    expect(dark.foreground).not.toBe(light.foreground);
    expect(harness.pty.spawned).toEqual([proc]);
  });

  it('applies font / scrollback / Option settings to open panels', async () => {
    const harness = await setup();
    const { view } = await openRunning(harness, 'shell');
    harness.ctx.settings.fontSize = 17;
    harness.ctx.settings.optionIsMeta = false;
    await harness.ctx.saveSettings();
    expect(view.terminal!.options.fontSize).toBe(17);
    expect(view.terminal!.options.macOptionIsMeta).toBe(false);
  });

  it('closing the panel detaches; the program stops after the grace period (R6.6)', async () => {
    const harness = await setup();
    const { view, proc, leaf } = await openRunning(harness, 'shell');
    leaf.detach();
    expect(view.isClosed).toBe(true);
    expect(view.terminal).toBeUndefined();
    expect(harness.sessions.get(view.panelId!)!.attached).toBe(false);
    await waitFor(() => proc.killReason === 'detached', FAST.graceMs * 4);
  });

  it('a view rebuilt with the same panel (old view first) takes over the running program (R6.1)', async () => {
    const harness = await setup();
    stubFit(100, 30);
    const { view, proc, leaf } = await openRunning(harness, 'claude');
    proc.emitData('half a reply');
    await sleep(5);
    const state = leaf.getViewState();
    // Obsidian's view rebuild: open(empty) closes the old view, then setViewState creates the new one.
    await leaf.setViewState(state);
    const moved = viewOf(leaf);
    expect(moved).not.toBe(view);
    await waitFor(() => bufferText(moved).includes('half a reply'));
    expect(harness.pty.spawned).toEqual([proc]);
    expect(moved.session?.state).toBe('running');
    await waitFor(() => proc.resizes.length >= 2);
    expect(proc.resizes.slice(-2)).toEqual([
      [99, 30],
      [100, 30],
    ]);
    moved.terminal!.input('x');
    expect(proc.input()).toBe('x');
  });

  it('moving to another window rebuilds the xterm from the mirror, keeping modes (R6.1, R6.2)', async () => {
    const listeners: Array<(win: Window) => void> = [];
    const proto = HTMLElement.prototype as unknown as { onWindowMigrated?: unknown };
    proto.onWindowMigrated = function (cb: (win: Window) => void) {
      listeners.push(cb);
      return () => undefined;
    };
    try {
      const harness = await setup();
      stubFit(90, 25);
      const { view, proc } = await openRunning(harness, 'claude');
      proc.emitData('\x1b[?2004hprompt> ');
      await sleep(5);
      await flushTerm(view);
      const before = view.terminal;
      expect(listeners).toHaveLength(1);
      listeners[0]!(window);
      expect(view.terminal).not.toBe(before);
      await waitFor(() => bufferText(view).includes('prompt>'));
      expect(view.terminal!.modes.bracketedPasteMode).toBe(true);
      expect(harness.pty.spawned).toEqual([proc]);
      // Pasting three lines arrives as one bracketed paste (R6.2).
      view.terminal!.paste('a\nb\nc');
      expect(proc.input()).toBe('\x1b[200~a\rb\rc\x1b[201~');
    } finally {
      delete proto.onWindowMigrated;
    }
  });

  it('a duplicated view (split / open in new window) gets a new panelId and a fresh session (R6.5)', async () => {
    const harness = await setup();
    harness.ctx.spawn.add('sid', (c) => ({ sessionId: c.sessionId ?? `sid-${c.panelId}` }));
    const { view, proc, leaf } = await openRunning(harness, 'claude');
    const saves = harness.app.workspace.layoutSaveRequests;
    const dupLeaf = new WorkspaceLeaf(harness.app, 'main');
    harness.app.workspace.leaves.push(dupLeaf);
    await dupLeaf.setViewState(leaf.getViewState());
    const dup = viewOf(dupLeaf);
    expect(dup.session).toBeUndefined();
    await waitFor(() => harness.pty.spawned.length === 2 && dup.session?.state === 'running', 2_000);
    expect(dup.panelId).not.toBe(view.panelId);
    expect(dup.getState()).toEqual({ profile: 'claude', panelId: dup.panelId, sessionId: `sid-${dup.panelId}` });
    expect(harness.app.workspace.layoutSaveRequests).toBeGreaterThan(saves);
    expect(view.session?.state).toBe('running');
    expect(proc.killReason).toBeUndefined();
    expect(harness.events.filter((e) => e[0] === 'session:spawning').map((e) => (e[1] as { phase: string }).phase)).toEqual(['new', 'new']);
  });

  it('input typed into a pending duplicate never reaches the original program', async () => {
    const harness = await setup();
    const { proc, leaf } = await openRunning(harness, 'shell');
    const dupLeaf = new WorkspaceLeaf(harness.app, 'main');
    await dupLeaf.setViewState(leaf.getViewState());
    viewOf(dupLeaf).terminal!.input('oops');
    expect(proc.input()).toBe('');
  });

  it('plugin teardown stops sessions before views close and keeps views from starting new ones (R7.8)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'shell');
    harness.plugin.load();
    harness.plugin.unload();
    expect(harness.terminals.isTearingDown()).toBe(true);
    expect(proc.killReason).toBe('unload');
    expect(view.isRunning()).toBe(false);
    // A view that gets a new state while the plugin is going away does not start anything.
    await view.setState({ profile: 'shell', panelId: 'late' }, { history: false });
    await sleep(10);
    expect(harness.pty.spawned).toEqual([proc]);
    expect(harness.sessions.list()).toEqual([]);
  });

  it('terminals service finds views by panel and leaf', async () => {
    const harness = await setup();
    const opened: string[] = [];
    harness.terminals.onViewOpen((v) => opened.push(v.profile));
    const { view, leaf } = await openRunning(harness, 'agy');
    expect(opened).toEqual(['agy']);
    expect(harness.terminals.views()).toEqual([view]);
    expect(harness.terminals.viewOf(view.panelId!)).toBe(view);
    expect(harness.terminals.viewOfLeaf(leaf as never)).toBe(view);
    leaf.detach();
    expect(harness.terminals.views()).toEqual([]);
  });

  it('the registry sink of a view restores into a fresh xterm (FakeSink parity check)', async () => {
    const harness = await setup();
    const sink = new FakeSink();
    harness.sessions.attach({ panelId: 'x', profile: 'shell', phase: 'new', sink });
    await waitFor(() => harness.sessions.get('x')?.state === 'running');
    expect(sink.restores).toEqual([]);
  });
});
