// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_VIEW_TYPE } from '../../src/core';
import { CloseFlow, closeQuestion, ConfirmCloseModal, openModalIn, STOP_WAIT_MS } from '../../src/terminal/closeFlow';
import type { CloseFlowModuleOptions } from '../../src/terminal/closeFlowModule';
import type { TerminalView } from '../../src/terminal/TerminalView';
import { MarkdownView, Modal, WorkspaceLeaf, type ButtonComponent as MockButton } from '../mocks/obsidian';
import { deferred, sleep, waitFor } from '../session/helpers';
import { makeKeyboardHarness, openRunning, press, type KeyboardHarness } from '../keyboard/helpers';

const ORIGINAL_DETACH = WorkspaceLeaf.prototype.detach;
let h: KeyboardHarness | null = null;

beforeEach(() => {
  Modal.open = [];
});

afterEach(() => {
  h?.runtime.unload();
  h = null;
  for (const m of [...Modal.open]) m.close();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  expect(WorkspaceLeaf.prototype.detach).toBe(ORIGINAL_DETACH);
});

async function setup(closeFlow: CloseFlowModuleOptions = {}): Promise<KeyboardHarness> {
  h = await makeKeyboardHarness({ closeFlow });
  return h;
}

function dialogs(): ConfirmCloseModal[] {
  return (Modal.open as unknown[]).filter((m): m is ConfirmCloseModal => m instanceof ConfirmCloseModal);
}

/** The dialog's buttons are mock ButtonComponents at runtime. */
function button(b: unknown): MockButton {
  return b as MockButton;
}

async function nextDialog(): Promise<ConfirmCloseModal> {
  await waitFor(() => dialogs().length > 0);
  return dialogs()[0]!;
}

function isDetached(view: TerminalView): boolean {
  return (view.leaf as unknown as WorkspaceLeaf).detached;
}

describe('single close (R7.3–R7.5)', () => {
  it('Cmd+W on a running panel asks; Cancel keeps panel and process', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'claude');
    press(view, { key: 'w', code: 'KeyW', metaKey: true });
    const dialog = await nextDialog();
    expect(dialog.contentEl.textContent).toContain('Claude Code is still running — stop it and close?');
    expect(button(dialog.stopButton).text).toBe('Stop and close');
    expect(button(dialog.cancelButton).text).toBe('Cancel');
    button(dialog.cancelButton).click();
    await sleep(10);
    expect(dialogs()).toHaveLength(0);
    expect(isDetached(view)).toBe(false);
    expect(view.isClosed).toBe(false);
    expect(proc.killReason).toBeUndefined();
    expect(view.session?.state).toBe('running');
  });

  it('"Stop and close" awaits sessions.stop(panelId, "close") and then closes the panel', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'claude');
    const panelId = view.panelId!;
    const realStop = harness.sessions.stop.bind(harness.sessions);
    const stop = vi.spyOn(harness.sessions, 'stop');
    const exited = deferred();
    stop.mockImplementation(async (id, reason) => {
      await realStop(id, reason);
      await exited.promise;
    });
    press(view, { key: 'w', code: 'KeyW', metaKey: true });
    button((await nextDialog()).stopButton).click();
    await waitFor(() => stop.mock.calls.length === 1);
    expect(stop).toHaveBeenCalledWith(panelId, 'close');
    await sleep(10);
    expect(proc.killReason).toBe('close');
    expect(isDetached(view)).toBe(false);
    exited.resolve();
    await waitFor(() => isDetached(view));
    expect(view.isClosed).toBe(true);
    await waitFor(() => harness.sessions.get(panelId) === undefined);
    expect(harness.events.some(([name, p]) => name === 'session:stopped' && (p as { reason: string }).reason === 'close')).toBe(true);
  });

  it('an exited panel closes immediately on Cmd+W (R7.5)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'agy');
    proc.exit(1);
    await waitFor(() => view.session?.state === 'exited');
    press(view, { key: 'w', code: 'KeyW', metaKey: true });
    await waitFor(() => isDetached(view));
    expect(dialogs()).toHaveLength(0);
  });

  it('the tab close button (leaf.detach) on a running panel shows the same dialog (R7.4)', async () => {
    const harness = await setup();
    const { view, leaf } = await openRunning(harness, 'agy');
    leaf.detach();
    expect(isDetached(view)).toBe(false);
    const dialog = await nextDialog();
    expect(dialog.labels).toEqual(['Antigravity']);
    expect(dialog.contentEl.textContent).toContain('Antigravity is still running — stop it and close?');
    button(dialog.stopButton).click();
    await waitFor(() => isDetached(view));
  });

  it('closing the dialog with Escape counts as Cancel; asking again works', async () => {
    const harness = await setup();
    const { view, leaf } = await openRunning(harness);
    leaf.detach();
    leaf.detach(); // repeated click while the dialog is open: still one dialog
    const first = await nextDialog();
    await sleep(5);
    expect(dialogs()).toHaveLength(1);
    first.close();
    await sleep(5);
    expect(isDetached(view)).toBe(false);
    leaf.detach();
    const second = await nextDialog();
    expect(second).not.toBe(first);
    button(second.stopButton).click();
    await waitFor(() => isDetached(view));
  });

  it('a program that does not stop in time still lets the panel close', async () => {
    const harness = await setup({ stopWaitMs: 30 });
    const { view, leaf } = await openRunning(harness);
    vi.spyOn(harness.sessions, 'stop').mockReturnValue(new Promise<void>(() => {}));
    leaf.detach();
    button((await nextDialog()).stopButton).click();
    await waitFor(() => isDetached(view));
    expect(harness.logs.some((l) => l.includes('closing anyway'))).toBe(true);
    expect(STOP_WAIT_MS).toBeGreaterThan(5_000);
  });
});

describe('batch close (R7.6)', () => {
  async function openFour(harness: KeyboardHarness) {
    const a = await openRunning(harness, 'claude');
    const b = await openRunning(harness, 'agy');
    const c = await openRunning(harness, 'shell');
    c.proc.exit(0);
    await waitFor(() => c.view.session?.state === 'exited');
    const md = new WorkspaceLeaf(harness.app);
    md.view = new MarkdownView(md);
    harness.app.workspace.leaves.push(md);
    return { a, b, c, md };
  }

  it('"Close all" asks once for every running panel; others close immediately; confirm stops both', async () => {
    const harness = await setup();
    const { a, b, c, md } = await openFour(harness);
    // Obsidian's tab menu: a synchronous detach loop.
    for (const leaf of [a.leaf, md, b.leaf, c.leaf]) leaf.detach();
    expect(md.detached).toBe(true);
    expect(isDetached(c.view)).toBe(true);
    expect(isDetached(a.view) || isDetached(b.view)).toBe(false);
    const dialog = await nextDialog();
    await sleep(5);
    expect(dialogs()).toHaveLength(1);
    expect(dialog.labels).toEqual(['Claude Code', 'Antigravity']);
    expect(dialog.contentEl.textContent).toContain('2 terminals are still running — stop them and close?');
    const items = [...dialog.contentEl.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual(['Claude Code', 'Antigravity']);
    button(dialog.stopButton).click();
    await waitFor(() => isDetached(a.view) && isDetached(b.view));
    expect(a.proc.killReason).toBe('close');
    expect(b.proc.killReason).toBe('close');
  });

  it('Cancel keeps every running panel of the batch', async () => {
    const harness = await setup();
    const { a, b, c } = await openFour(harness);
    for (const leaf of [a.leaf, b.leaf, c.leaf]) leaf.detach();
    button((await nextDialog()).cancelButton).click();
    await sleep(10);
    expect(isDetached(a.view) || isDetached(b.view)).toBe(false);
    expect(a.proc.killReason ?? b.proc.killReason).toBeUndefined();
    expect(isDetached(c.view)).toBe(true);
  });

  it('closeQuestion wording', () => {
    expect(closeQuestion(['Shell'])).toBe('Shell is still running — stop it and close?');
    expect(closeQuestion(['Claude Code', 'Claude Code', 'Antigravity'])).toBe('3 terminals are still running — stop them and close?');
  });
});

describe('closes Obsidian performs itself never ask (R7.7, R7.8)', () => {
  it('app quit', async () => {
    const harness = await setup();
    const { view, leaf } = await openRunning(harness);
    harness.app.workspace.trigger('quit', {});
    leaf.detach();
    expect(isDetached(view)).toBe(true);
    await sleep(5);
    expect(dialogs()).toHaveLength(0);
  });

  it('workspace-layout load', async () => {
    const harness = await setup();
    const { view, leaf } = await openRunning(harness);
    harness.app.workspace.layoutReady = false;
    leaf.detach();
    expect(isDetached(view)).toBe(true);
  });

  it('popout-window close: the window left the workspace before its leaves are detached', async () => {
    const harness = await setup();
    const a = await openRunning(harness);
    const b = await openRunning(harness);
    const closingWindow = new Set([b.leaf]);
    (harness.app.workspace as unknown as { isAttached: (l: WorkspaceLeaf) => boolean }).isAttached = (l) => !closingWindow.has(l);
    b.leaf.detach();
    expect(isDetached(b.view)).toBe(true);
    // Leaves still in the workspace keep asking.
    a.leaf.detach();
    expect(isDetached(a.view)).toBe(false);
    button((await nextDialog()).cancelButton).click();
  });

  it('popout-window close detected from the leaf root when workspace.isAttached is unavailable', async () => {
    const harness = await setup();
    const { view, leaf } = await openRunning(harness);
    const ws = harness.app.workspace as unknown as Record<string, unknown>;
    ws.rootSplit = { id: 'root' };
    ws.floatingSplit = { id: 'floating' };
    const detachedWindow = { id: 'window' };
    (leaf as unknown as { getRoot: () => unknown }).getRoot = () => detachedWindow;
    leaf.detach();
    expect(isDetached(view)).toBe(true);
  });

  it('a drag in progress (moves are not closes)', async () => {
    const harness = await setup();
    const { view, leaf } = await openRunning(harness);
    (harness.app as unknown as { dragManager: unknown }).dragManager = { draggable: { type: 'leaf' } };
    leaf.detach();
    expect(isDetached(view)).toBe(true);
  });

  it('plugin disable: Obsidian detaches the terminal leaves after our cleanup — no dialog, sessions stop', async () => {
    const harness = await setup();
    const a = await openRunning(harness, 'claude');
    const b = await openRunning(harness, 'agy');
    harness.plugin.load();
    harness.plugin.unload(); // plugin cleanups (T3 marks tearing down, stops sessions)
    harness.app.workspace.detachLeavesOfType(TERMINAL_VIEW_TYPE);
    for (const leaf of [a.leaf, b.leaf]) leaf.detach();
    expect(isDetached(a.view) && isDetached(b.view)).toBe(true);
    await sleep(5);
    expect(dialogs()).toHaveLength(0);
    expect(a.proc.killReason).toBe('unload');
    expect(b.proc.killReason).toBe('unload');
  });
});

describe('detach wrapper lifecycle', () => {
  it('is installed on load and restored on unload', async () => {
    const harness = await setup();
    expect(WorkspaceLeaf.prototype.detach).not.toBe(ORIGINAL_DETACH);
    harness.runtime.unload();
    h = null;
    expect(WorkspaceLeaf.prototype.detach).toBe(ORIGINAL_DETACH);
  });

  it('unload closes an open dialog as Cancel and later detaches pass straight through', async () => {
    const harness = await setup();
    const { view, leaf, proc } = await openRunning(harness);
    leaf.detach();
    await nextDialog();
    harness.runtime.unload();
    h = null;
    expect(dialogs()).toHaveLength(0);
    await sleep(5);
    expect(isDetached(view)).toBe(false);
    leaf.detach();
    expect(isDetached(view)).toBe(true);
    expect(proc.killReason).toBe('unload');
  });

  it('when something wrapped detach after us, unload leaves our wrapper as a pass-through', async () => {
    const harness = await setup();
    const ours = WorkspaceLeaf.prototype.detach;
    const calls: string[] = [];
    const theirs = function (this: WorkspaceLeaf) {
      calls.push('theirs');
      ours.call(this);
    };
    WorkspaceLeaf.prototype.detach = theirs;
    const { view, leaf } = await openRunning(harness);
    harness.runtime.unload();
    h = null;
    expect(WorkspaceLeaf.prototype.detach).toBe(theirs);
    leaf.detach();
    expect(calls).toEqual(['theirs']);
    expect(isDetached(view)).toBe(true);
    WorkspaceLeaf.prototype.detach = ORIGINAL_DETACH;
  });

  it('a second install is a no-op; uninstall without install is harmless', () => {
    const flow = new CloseFlow({
      app: {} as never,
      terminals: { viewOfLeaf: () => undefined } as never,
      sessions: {} as never,
      log: console as never,
      isTearingDown: () => false,
    });
    flow.uninstall();
    flow.install();
    const wrapped = WorkspaceLeaf.prototype.detach;
    flow.install();
    expect(WorkspaceLeaf.prototype.detach).toBe(wrapped);
    expect(flow.installed).toBe(true);
    flow.uninstall();
    expect(WorkspaceLeaf.prototype.detach).toBe(ORIGINAL_DETACH);
  });
});

describe('dialog window', () => {
  it('opens in the panel window: activeWindow points there during open() and is restored after', () => {
    const g = globalThis as { activeWindow?: unknown; activeDocument?: unknown };
    const main = { closed: false, document: { name: 'main-doc' } } as unknown as Window;
    const popout = { closed: false, document: { name: 'popout-doc' } } as unknown as Window;
    g.activeWindow = main;
    g.activeDocument = main.document;
    const seen: unknown[] = [];
    const modal = { open: () => seen.push(g.activeWindow, g.activeDocument) } as unknown as Modal;
    try {
      openModalIn(modal as never, popout);
      expect(seen).toEqual([popout, popout.document]);
      expect(g.activeWindow).toBe(main);
      openModalIn(modal as never, main);
      expect(seen.slice(2)).toEqual([main, main.document]);
      // A window that is already closed is not used.
      openModalIn(modal as never, { closed: true, document: {} } as unknown as Window);
      expect(seen.slice(4)).toEqual([main, main.document]);
    } finally {
      delete g.activeWindow;
      delete g.activeDocument;
    }
  });
});
