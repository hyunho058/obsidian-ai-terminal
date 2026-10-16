import { Scope } from 'obsidian';
import type { Terminal } from '@xterm/xterm';
import type { EnterInterceptor, KeyHandler, TerminalPanelHandle } from '../core';
import type { Logger } from '../util/log';

/** Longest an Enter waits for the Enter interceptors (each bounds its own wait; this is only a safety net). */
export const ENTER_HOLD_CAP_MS = 3_000;

/** Bytes the keyboard routing sends to the program (D10). */
export const KEY_SEQUENCES = {
  /** Cmd+← — Ctrl+A, line start. */
  lineStart: '\x01',
  /** Cmd+→ — Ctrl+E, line end. */
  lineEnd: '\x05',
  /** Option+← with Option as Meta — ESC b, word left. */
  wordLeft: '\x1bb',
  /** Option+→ with Option as Meta — ESC f, word right. */
  wordRight: '\x1bf',
  /** Shift+Enter — ESC CR, a newline inside Claude Code's prompt. */
  newline: '\x1b\r',
} as const;

/** The terminal's own Cmd shortcuts; every other Cmd shortcut belongs to Obsidian (R4.2). */
export type TerminalCmdAction = 'copy' | 'paste' | 'select-all' | 'clear' | 'line-start' | 'line-end' | 'close';

/** Clipboard used by Cmd+C / Cmd+V. A synchronous `readText` keeps a paste in order with the keys typed after it. */
export interface TerminalClipboard {
  readText(): string | Promise<string>;
  writeText(text: string): void | Promise<void>;
}

export interface KeyRouterOptions {
  /** `settings.optionIsMeta`, read at key time. */
  optionIsMeta(): boolean;
  /** Current Enter interceptors (`ctx.keyboard.enterInterceptors`). */
  interceptors(): readonly EnterInterceptor[];
  clipboard: TerminalClipboard;
  /** Cmd+W: close the panel through the close flow (D26). Called after the key event has been handled. */
  close(panel: TerminalPanelHandle): void;
  log: Logger;
  enterHoldCapMs?: number;
}

/** A key event that belongs to an IME composition (R4.1): left untouched for xterm's composition handling. */
export function isImeEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * Lower-case letter of a letter key, independent of the input source (Cmd+C with the Korean layout reports key "ㅊ"
 * but code "KeyC"); other keys keep their `key` value.
 */
export function keyName(event: KeyboardEvent): string {
  const key = event.key ?? '';
  if (/^[a-zA-Z]$/.test(key)) return key.toLowerCase();
  if (typeof event.code === 'string' && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  return key;
}

/** The terminal action of a Cmd chord (Cmd alone, no other modifier), or null when the chord belongs to Obsidian. */
export function terminalCmdAction(event: KeyboardEvent): TerminalCmdAction | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  switch (keyName(event)) {
    case 'c':
      return 'copy';
    case 'v':
      return 'paste';
    case 'a':
      return 'select-all';
    case 'k':
      return 'clear';
    case 'w':
      return 'close';
    case 'ArrowLeft':
      return 'line-start';
    case 'ArrowRight':
      return 'line-end';
    default:
      return null;
  }
}

function noModifiers(event: KeyboardEvent): boolean {
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

function isShiftEnter(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/** One character (Option+B → "∫"), not a named key such as "ArrowLeft" or "Dead". */
function isCharacter(key: string): boolean {
  return key.length > 0 && [...key].length === 1;
}

/** Handled here: xterm must not see it, and the browser must not act on it (no keypress, no textarea edit). */
function cancel(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/** Sends bytes as if typed, so they queue behind an Enter hold like any other key (falls back to the PTY directly). */
function typeInto(panel: TerminalPanelHandle, data: string): void {
  const term = panel.terminal;
  if (term) term.input(data, true);
  else panel.sendInput(data);
}

/**
 * Runs the Enter interceptors for one Enter (D31 seam for T9). They all start right away; resolves when every one has
 * settled or after `capMs`, whichever comes first. Throwing / rejecting interceptors are logged and count as settled.
 */
export async function runEnterInterceptors(
  panel: TerminalPanelHandle,
  interceptors: readonly EnterInterceptor[],
  log: Logger,
  capMs: number = ENTER_HOLD_CAP_MS,
): Promise<'done' | 'cap'> {
  const runs = interceptors.map((interceptor) => {
    try {
      return Promise.resolve(interceptor(panel)).then(
        () => undefined,
        (err) => log.error('Enter interceptor failed', err),
      );
    } catch (err) {
      log.error('Enter interceptor failed', err);
      return Promise.resolve();
    }
  });
  let timer: number | undefined;
  const cap = new Promise<'cap'>((resolve) => {
    timer = window.setTimeout(() => resolve('cap'), capMs);
  });
  const outcome = await Promise.race([Promise.all(runs).then(() => 'done' as const), cap]);
  if (timer) window.clearTimeout(timer);
  if (outcome === 'cap') log.warn(`Enter interceptors still busy after ${capMs} ms — sending the Enter anyway`);
  return outcome;
}

/**
 * Keyboard routing for terminal panels (D10), registered through `ctx.keyboard.onKey`. Returns true when it consumed
 * the event (xterm then ignores it).
 *
 * Note: inside Obsidian xterm.js does not detect macOS (it sees Node's `process` and reports platform "node"), so
 * its Mac-only behaviour — Option as a third-level shift, Cmd+A select-all — is done here instead.
 */
export function createKeyRouter(options: KeyRouterOptions): KeyHandler {
  const capMs = options.enterHoldCapMs ?? ENTER_HOLD_CAP_MS;
  const { log, clipboard } = options;

  const copy = (term: Terminal | undefined): void => {
    const text = term?.getSelection() ?? '';
    if (!text) return;
    void Promise.resolve()
      .then(() => clipboard.writeText(text))
      .catch((err) => log.warn(`copy failed: ${err instanceof Error ? err.message : String(err)}`));
  };

  const paste = (panel: TerminalPanelHandle): void => {
    const term = panel.terminal;
    if (!term) return;
    // xterm's paste path adds the bracketed-paste markers when the program enabled them (R4.3).
    const deliver = (text: string): void => {
      if (text && panel.terminal === term) term.paste(text);
    };
    try {
      const text = clipboard.readText();
      if (typeof text === 'string') deliver(text);
      else void text.then(deliver, (err) => log.warn(`paste failed: ${err instanceof Error ? err.message : String(err)}`));
    } catch (err) {
      log.warn(`paste failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onCmd = (event: KeyboardEvent, panel: TerminalPanelHandle): boolean => {
    const action = event.type === 'keydown' ? terminalCmdAction(event) : null;
    // Cmd chords never reach the program. Ours are handled here; the rest are not prevented, so Obsidian's hotkeys
    // (already run by its capture-phase keymap) and the app menu keep working (R4.2).
    if (!action) return true;
    cancel(event);
    const term = panel.terminal;
    switch (action) {
      case 'copy':
        copy(term);
        break;
      case 'paste':
        paste(panel);
        break;
      case 'select-all':
        term?.selectAll();
        break;
      case 'clear': {
        const clear = (panel as TerminalPanelHandle & { clear?: () => void }).clear;
        if (typeof clear === 'function') clear.call(panel);
        else term?.clear();
        break;
      }
      case 'line-start':
        typeInto(panel, KEY_SEQUENCES.lineStart);
        break;
      case 'line-end':
        typeInto(panel, KEY_SEQUENCES.lineEnd);
        break;
      case 'close':
        // After this key event: closing disposes the xterm that is dispatching it.
        queueMicrotask(() => options.close(panel));
        break;
    }
    return true;
  };

  const onOption = (event: KeyboardEvent, panel: TerminalPanelHandle): boolean => {
    if (options.optionIsMeta()) {
      // xterm already sends ESC + key for Option+letter / digit / punctuation; it sends CSI 1;3 D/C for the arrows.
      if (!event.shiftKey && event.key === 'ArrowLeft') {
        cancel(event);
        typeInto(panel, KEY_SEQUENCES.wordLeft);
        return true;
      }
      if (!event.shiftKey && event.key === 'ArrowRight') {
        cancel(event);
        typeInto(panel, KEY_SEQUENCES.wordRight);
        return true;
      }
      return false;
    }
    // Option types the macOS character (R4.5). A dead key (Option+E …) is left to the browser: the accent arrives
    // through composition events, which xterm handles.
    if (event.key === 'Dead') return true;
    if (isCharacter(event.key)) {
      cancel(event);
      typeInto(panel, event.key);
      return true;
    }
    return false;
  };

  const dispatchEnter = (panel: TerminalPanelHandle): void => {
    if (panel.state !== 'running') return;
    const interceptors = options.interceptors();
    if (interceptors.length === 0) return;
    // The Enter itself is not consumed: xterm sends any pending IME text and then CR into the session — both are
    // queued by this hold, together with everything typed after it, and flushed in order on release.
    const release = panel.holdInput();
    void runEnterInterceptors(panel, interceptors, log, capMs).finally(release);
  };

  return (event, panel) => {
    if (isImeEvent(event)) return false;
    if (event.metaKey) return onCmd(event, panel);
    if (event.type === 'keypress') return isShiftEnter(event);
    if (event.type !== 'keydown') return false;
    if (isShiftEnter(event)) {
      cancel(event);
      typeInto(panel, KEY_SEQUENCES.newline);
      return true;
    }
    if (event.altKey && !event.ctrlKey) return onOption(event, panel);
    if (event.key === 'Enter' && noModifiers(event)) dispatchEnter(panel);
    return false;
  };
}

/** What `terminalOwnsKey` needs from a terminal view. */
export interface KeyOwnerView {
  readonly terminal: Terminal | undefined;
  readonly session: unknown;
}

/**
 * True when a key typed into this terminal must not trigger Obsidian hotkeys: every key except Cmd chords the terminal
 * does not use (R4.2, R4.7). Keys outside the terminal (or while it has no session) keep Obsidian's normal handling.
 */
export function terminalOwnsKey(event: KeyboardEvent, view: KeyOwnerView): boolean {
  if (!view.session) return false;
  const el = view.terminal?.element;
  const target = event.target as Node | null;
  if (!el || !target || typeof (target as { nodeType?: unknown }).nodeType !== 'number' || !el.contains(target)) return false;
  return !event.metaKey || terminalCmdAction(event) !== null;
}

/**
 * Hotkey isolation (R4.7). Obsidian's keymap listens for keydown on every window in the capture phase and asks the
 * active leaf's `view.scope`; Obsidian's own views use `new Scope(app.scope)`, and `app.scope` holds the hotkey
 * manager's catch-all handler that runs command hotkeys. This scope answers `true` for keys the terminal owns — that
 * ends the lookup *without* preventDefault, so the event still reaches xterm — and `undefined` otherwise, which falls
 * through to `parent` (Cmd+P and every other Obsidian hotkey).
 */
export function createTerminalScope(parent: Scope | undefined, owns: (event: KeyboardEvent) => boolean): Scope {
  const scope = new Scope(parent);
  scope.register(null, null, (event) => (owns(event) ? true : undefined));
  return scope;
}

interface ElectronClipboard {
  readText(): string;
  writeText(text: string): void;
}

function electronClipboard(): ElectronClipboard | null {
  try {
    // Obsidian desktop only (isDesktopOnly). Loaded lazily so a missing module falls back to the web clipboard.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the synchronous clipboard keeps paste order exact
    const electron = require('electron') as { clipboard?: ElectronClipboard } | undefined;
    const clipboard = electron?.clipboard;
    return clipboard && typeof clipboard.readText === 'function' && typeof clipboard.writeText === 'function' ? clipboard : null;
  } catch {
    return null;
  }
}

/** Electron's synchronous clipboard in Obsidian; the async web clipboard elsewhere. */
export function createClipboard(): TerminalClipboard {
  const electron = electronClipboard();
  if (electron) return { readText: () => electron.readText(), writeText: (text) => electron.writeText(text) };
  return {
    readText: () => navigator.clipboard.readText(),
    writeText: (text) => navigator.clipboard.writeText(text),
  };
}
