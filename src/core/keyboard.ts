import type { Disposer, TerminalPanelHandle } from './types';

/**
 * Called for every key event xterm sees in a terminal panel (keydown, keypress and keyup — check
 * `event.type`). Return `true` if the handler consumed the event: xterm will then not process it.
 */
export type KeyHandler = (event: KeyboardEvent, panel: TerminalPanelHandle) => boolean;

/**
 * Called before an Enter (outside IME composition) is forwarded to the program. The keyboard dispatcher (T4)
 * holds that Enter — and queues later input behind it — until every interceptor has settled.
 * Interceptors must bound their own wait (e.g. T9's agy snapshot hold: 2 s).
 */
export type EnterInterceptor = (panel: TerminalPanelHandle) => Promise<void> | void;

type ErrorReporter = (message: string, err?: unknown) => void;

/** Keyboard extension points. T3's terminal calls `dispatchKey`; T4 registers the routing handler. */
export class KeyboardHooks {
  private readonly keyHandlers: KeyHandler[] = [];
  private readonly interceptors: EnterInterceptor[] = [];

  constructor(private readonly report: ErrorReporter = (m, e) => console.error(m, e)) {}

  onKey(handler: KeyHandler): Disposer {
    this.keyHandlers.push(handler);
    return () => remove(this.keyHandlers, handler);
  }

  onEnterIntercept(handler: EnterInterceptor): Disposer {
    this.interceptors.push(handler);
    return () => remove(this.interceptors, handler);
  }

  /**
   * Runs the key handlers in registration order until one returns `true`.
   * A throwing handler is reported and counts as "not consumed".
   * Call from xterm's `attachCustomKeyEventHandler`: `return !keyboard.dispatchKey(ev, panel)`.
   */
  dispatchKey(event: KeyboardEvent, panel: TerminalPanelHandle): boolean {
    for (const handler of [...this.keyHandlers]) {
      try {
        if (handler(event, panel)) return true;
      } catch (err) {
        this.report('key handler failed', err);
      }
    }
    return false;
  }

  /** Current Enter interceptors in registration order (the T4 dispatcher runs them). */
  enterInterceptors(): readonly EnterInterceptor[] {
    return [...this.interceptors];
  }

  clear(): void {
    this.keyHandlers.length = 0;
    this.interceptors.length = 0;
  }
}

function remove<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}
