import { Scope as MockScope } from '../mocks/obsidian';
import { createSessionModule } from '../../src/session/index';
import type { SessionRegistry } from '../../src/session/SessionRegistry';
import { createCloseFlowModule, type CloseFlowModuleOptions } from '../../src/terminal/closeFlowModule';
import { createTerminalModule, type TerminalViewsService } from '../../src/terminal/index';
import type { TerminalClipboard } from '../../src/terminal/keyboard';
import { createKeyboardModule, type KeyboardModuleOptions } from '../../src/terminal/keyboardModule';
import type { TerminalView } from '../../src/terminal/TerminalView';
import type { WorkspaceLeaf } from '../mocks/obsidian';
import { makeHarness, waitFor, type Harness } from '../session/helpers';
import { FAST } from '../terminal/helpers';

export class FakeClipboard implements TerminalClipboard {
  text = '';
  /** Answer reads asynchronously (like `navigator.clipboard`). */
  async = false;
  writes: string[] = [];
  /** Whether the clipboard holds an image. */
  image = false;
  hasImageCalls = 0;
  readText(): string | Promise<string> {
    return this.async ? Promise.resolve(this.text) : this.text;
  }
  writeText(text: string): void {
    this.text = text;
    this.writes.push(text);
  }
  hasImage(): boolean {
    this.hasImageCalls++;
    return this.image;
  }
}

export interface KeyboardHarness extends Harness {
  terminals: TerminalViewsService;
  sessions: SessionRegistry;
  clipboard: FakeClipboard;
}

/** Fake pty + the real session, terminal, keyboard and (optionally) close-flow modules. */
export async function makeKeyboardHarness(
  opts: { keyboard?: KeyboardModuleOptions; closeFlow?: CloseFlowModuleOptions | false } = {},
): Promise<KeyboardHarness> {
  const clipboard = new FakeClipboard();
  const modules = [
    createSessionModule(FAST),
    createTerminalModule(),
    createKeyboardModule({ clipboard, ...opts.keyboard }),
    ...(opts.closeFlow === false ? [] : [createCloseFlowModule(opts.closeFlow ?? {})]),
  ];
  const h = await makeHarness({ noRegistry: true, extraModules: modules });
  const sessions = h.ctx.services.require('sessions') as SessionRegistry;
  return { ...h, registry: sessions, sessions, terminals: h.ctx.services.require('terminals'), clipboard };
}

export async function openRunning(h: KeyboardHarness, profile: 'claude' | 'agy' | 'shell' = 'shell') {
  const view = (await h.terminals.open(profile))!;
  await waitFor(() => view.session?.state === 'running');
  // Key events must bubble to the window like in Obsidian (capture-phase keymap).
  if (!view.containerEl.isConnected) document.body.appendChild(view.containerEl);
  return { view, proc: h.pty.last, leaf: view.leaf as unknown as WorkspaceLeaf };
}

export type KeyInit = KeyboardEventInit & { keyCode?: number; charCode?: number };

export function keyEvent(type: 'keydown' | 'keypress' | 'keyup', init: KeyInit): KeyboardEvent {
  const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (init.charCode !== undefined) Object.defineProperty(ev, 'charCode', { value: init.charCode });
  return ev;
}

const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  Backspace: 8,
  Tab: 9,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

/** keyCode the browser would report for `init.key` (letters / digits / a few named keys). */
export function keyCodeOf(init: KeyInit): number {
  if (init.keyCode !== undefined) return init.keyCode;
  const key = init.key ?? '';
  if (KEY_CODES[key] !== undefined) return KEY_CODES[key]!;
  if (init.code && /^Key[A-Z]$/.test(init.code)) return init.code.charCodeAt(3);
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return 0;
}

export interface Pressed {
  down: KeyboardEvent;
  press: KeyboardEvent | null;
  up: KeyboardEvent;
}

/**
 * A browser-like key press on `target` (xterm's textarea by default): keydown; then keypress for a key that produces a
 * character (or Enter) unless keydown was prevented or Cmd/Ctrl is held; then keyup.
 */
export function press(view: TerminalView, init: KeyInit, target?: EventTarget): Pressed {
  const el = target ?? view.terminal!.textarea!;
  const full: KeyInit = { ...init, keyCode: keyCodeOf(init) };
  const down = keyEvent('keydown', full);
  el.dispatchEvent(down);
  let pressEv: KeyboardEvent | null = null;
  const key = init.key ?? '';
  const producesChar = (key.length === 1 || key === 'Enter') && !init.metaKey && !init.ctrlKey;
  if (!down.defaultPrevented && producesChar) {
    pressEv = keyEvent('keypress', { ...full, charCode: key === 'Enter' ? 13 : key.charCodeAt(0) });
    el.dispatchEvent(pressEv);
  }
  const up = keyEvent('keyup', full);
  el.dispatchEvent(up);
  return { down, press: pressEv, up };
}

// ---------------------------------------------------------------- Obsidian keymap model (app.js 1.14.4)

type KeyHandlerEntry = { modifiers: string[] | null; key: string | null; func: (evt: KeyboardEvent, ctx: any) => any };

function compileModifiers(mods: string[]): string {
  return mods
    .map((m) => (m === 'Mod' ? 'Meta' : m))
    .sort()
    .join(',');
}

function eventModifiers(evt: KeyboardEvent): string {
  const mods: string[] = [];
  if (evt.ctrlKey) mods.push('Ctrl');
  if (evt.metaKey) mods.push('Meta');
  if (evt.altKey) mods.push('Alt');
  if (evt.shiftKey) mods.push('Shift');
  return compileModifiers(mods);
}

function isMatch(h: KeyHandlerEntry, info: { modifiers: string; key: string; vkey: string }): boolean {
  const mods = h.modifiers === null ? null : compileModifiers(h.modifiers);
  return (mods === null || mods === info.modifiers) && (!h.key || h.key === info.vkey || h.key.toLowerCase() === info.key.toLowerCase());
}

/** Obsidian's `Scope.handleKey` (keys in order; a catch-all returning undefined continues; then the parent). */
export function handleKey(scope: MockScope, evt: KeyboardEvent, info: { modifiers: string; key: string; vkey: string }): unknown {
  for (const h of scope.keys as KeyHandlerEntry[]) {
    if (!isMatch(h, info)) continue;
    const result = h.func(evt, info);
    if (result !== undefined) return result;
    if (h.key !== null || h.modifiers !== null) return result;
  }
  return scope.parent ? handleKey(scope.parent, evt, info) : undefined;
}

export interface KeymapModel {
  /** The app's root scope (`app.scope`): holds the hotkey manager's catch-all. */
  appScope: MockScope;
  /** Commands that ran through a hotkey. */
  ran: string[];
  bindHotkey(modifiers: string[], key: string, commandId: string): void;
  dispose(): void;
}

/**
 * Installs Obsidian's keymap on `win`: a capture-phase keydown listener that asks the active leaf's `view.scope`
 * (else `app.scope`) and prevents + stops the event when a handler returns false; the hotkey manager is a catch-all on
 * `app.scope` that runs a bound command and returns false.
 */
export function installKeymap(app: { workspace: { activeLeaf: WorkspaceLeaf | null }; scope?: unknown }, win: Window = window): KeymapModel {
  const appScope = new MockScope();
  const hotkeys: Array<{ modifiers: string; key: string; id: string }> = [];
  const ran: string[] = [];
  appScope.register(null, null, (_evt: KeyboardEvent, info: { modifiers: string; key: string; vkey: string }) => {
    for (const hk of hotkeys) {
      if (hk.modifiers === info.modifiers && (hk.key === info.vkey || hk.key.toLowerCase() === info.key.toLowerCase())) {
        ran.push(hk.id);
        return false;
      }
    }
    return undefined;
  });
  (app as { scope?: unknown }).scope = appScope;
  const listener = (evt: KeyboardEvent): void => {
    if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(evt.key)) return;
    const leafView = app.workspace.activeLeaf?.view as { scope?: MockScope | null } | undefined;
    const scope = leafView?.scope ?? appScope;
    const vkey = evt.code?.startsWith('Key') ? evt.code.slice(3) : evt.key;
    const info = { modifiers: eventModifiers(evt), key: evt.key, vkey };
    if (handleKey(scope, evt, info) === false) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  };
  win.addEventListener('keydown', listener, true);
  return {
    appScope,
    ran,
    bindHotkey: (modifiers, key, id) => hotkeys.push({ modifiers: compileModifiers(modifiers), key, id }),
    dispose: () => win.removeEventListener('keydown', listener, true),
  };
}
