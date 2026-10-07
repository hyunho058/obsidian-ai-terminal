// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scope } from '../mocks/obsidian';
import { sleep, waitFor } from '../session/helpers';
import { installKeymap, makeKeyboardHarness, openRunning, press, type KeyboardHarness, type KeymapModel } from './helpers';

let h: KeyboardHarness | null = null;
let keymap: KeymapModel | null = null;

afterEach(() => {
  keymap?.dispose();
  keymap = null;
  h?.runtime.unload();
  h = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function setup() {
  const confirms: string[][] = [];
  h = await makeKeyboardHarness({
    closeFlow: {
      confirm: async (request) => {
        confirms.push(request.labels);
        return false;
      },
    },
  });
  keymap = installKeymap(h.app as never);
  return { harness: h, keymap, confirms };
}

describe('hotkey isolation (R4.7, R4.2)', () => {
  it('a user hotkey on Ctrl+E does not run in the focused terminal; the program gets \\x05', async () => {
    const { harness, keymap } = await setup();
    keymap.bindHotkey(['Ctrl'], 'E', 'editor:custom');
    const { view, proc } = await openRunning(harness);
    expect(harness.app.workspace.activeLeaf).toBe(view.leaf);
    press(view, { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(keymap.ran).toEqual([]);
    expect(proc.input()).toBe('\x05');
  });

  it('Cmd+P still opens the command palette and sends nothing to the program', async () => {
    const { harness, keymap } = await setup();
    keymap.bindHotkey(['Mod'], 'P', 'command-palette:open');
    const { view, proc } = await openRunning(harness);
    const pressed = press(view, { key: 'p', code: 'KeyP', metaKey: true });
    expect(keymap.ran).toEqual(['command-palette:open']);
    expect(pressed.down.defaultPrevented).toBe(true);
    expect(proc.input()).toBe('');
  });

  it('the terminal keeps its own Cmd keys: an Obsidian hotkey on Cmd+W / Cmd+K does not run', async () => {
    const { harness, keymap, confirms } = await setup();
    keymap.bindHotkey(['Mod'], 'W', 'workspace:close');
    keymap.bindHotkey(['Mod'], 'K', 'editor:insert-link');
    const { view, proc } = await openRunning(harness, 'claude');
    press(view, { key: 'k', code: 'KeyK', metaKey: true });
    press(view, { key: 'w', code: 'KeyW', metaKey: true });
    await sleep(5);
    expect(keymap.ran).toEqual([]);
    expect(confirms).toEqual([['Claude Code']]);
    expect(proc.input()).toBe('');
  });

  it('Option, Escape, Tab, function keys and Ctrl+Tab go to the program, not to Obsidian hotkeys', async () => {
    const { harness, keymap } = await setup();
    keymap.bindHotkey(['Alt'], 'N', 'alt-n');
    keymap.bindHotkey(['Ctrl'], 'Tab', 'workspace:next-tab');
    keymap.bindHotkey([], 'F2', 'f2');
    keymap.bindHotkey([], 'Escape', 'esc');
    const { view, proc } = await openRunning(harness);
    press(view, { key: 'n', code: 'KeyN', altKey: true });
    press(view, { key: 'Tab', code: 'Tab', ctrlKey: true });
    press(view, { key: 'F2', code: 'F2', keyCode: 113 });
    press(view, { key: 'Escape', code: 'Escape' });
    press(view, { key: 'Tab', code: 'Tab' });
    expect(keymap.ran).toEqual([]);
    expect(proc.input()).toBe('\x1bn\t\x1bOQ\x1b\t');
  });

  it('keys outside the terminal keep Obsidian hotkeys even while the terminal leaf is active', async () => {
    const { harness, keymap } = await setup();
    keymap.bindHotkey(['Ctrl'], 'E', 'editor:custom');
    const { view, proc } = await openRunning(harness);
    const outside = document.body.appendChild(document.createElement('input'));
    press(view, { key: 'e', code: 'KeyE', ctrlKey: true }, outside);
    expect(keymap.ran).toEqual(['editor:custom']);
    expect(proc.input()).toBe('');
  });

  it('every terminal view gets a scope whose parent is app.scope (views opened before and after load)', async () => {
    const { harness, keymap } = await setup();
    const { view } = await openRunning(harness);
    const scope = view.scope as unknown as Scope;
    expect(scope).toBeInstanceOf(Scope);
    expect(scope.parent).toBe(keymap.appScope);
    const second = (await harness.terminals.open('agy'))!;
    await waitFor(() => second.scope !== null);
    expect((second.scope as unknown as Scope).parent).toBe(keymap.appScope);
    expect(second.scope).not.toBe(view.scope);
  });

  it('a view without a session (pending duplicate) keeps Obsidian behaviour', async () => {
    const { harness, keymap } = await setup();
    keymap.bindHotkey(['Ctrl'], 'E', 'editor:custom');
    const { view } = await openRunning(harness);
    vi.spyOn(view, 'session', 'get').mockReturnValue(undefined);
    press(view, { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(keymap.ran).toEqual(['editor:custom']);
  });
});
