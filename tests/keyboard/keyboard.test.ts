// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalPanelHandle } from '../../src/core';
import { createKeyRouter, ENTER_HOLD_CAP_MS, isImeEvent, KEY_SEQUENCES, runEnterInterceptors, terminalCmdAction } from '../../src/terminal/keyboard';
import { createLogger } from '../../src/util/log';
import { bufferText, flushTerm } from '../terminal/helpers';
import { deferred, sleep, waitFor } from '../session/helpers';
import { FakeClipboard, keyEvent, makeKeyboardHarness, openRunning, press, type KeyboardHarness } from './helpers';

let h: KeyboardHarness | null = null;

afterEach(() => {
  h?.runtime.unload();
  h = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup(opts: Parameters<typeof makeKeyboardHarness>[0] = {}): Promise<KeyboardHarness> {
  h = await makeKeyboardHarness(opts);
  return h;
}

const quietLog = createLogger(undefined, { debug() {}, info() {}, warn() {}, error() {} });

describe('key mappings (D10)', () => {
  it('Cmd+← / Cmd+→ send Ctrl+A / Ctrl+E (R4.4)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness);
    const left = press(view, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true });
    press(view, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true });
    expect(proc.input()).toBe('\x01\x05');
    expect(left.down.defaultPrevented).toBe(true);
  });

  it('Shift+Enter sends ESC CR and nothing else (R4.6)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'claude');
    const pressed = press(view, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(proc.input()).toBe(KEY_SEQUENCES.newline);
    expect(proc.input()).toBe('\x1b\r');
    expect(pressed.down.defaultPrevented).toBe(true);
    // A keypress that slips through anyway is swallowed too (no extra CR).
    view.terminal!.textarea!.dispatchEvent(keyEvent('keypress', { key: 'Enter', keyCode: 13, charCode: 13, shiftKey: true }));
    expect(proc.input()).toBe('\x1b\r');
  });

  it('Option as Meta: Option+← / Option+→ send ESC b / ESC f, Option+B sends ESC b (R4.5)', async () => {
    const harness = await setup();
    expect(harness.ctx.settings.optionIsMeta).toBe(true);
    const { view, proc } = await openRunning(harness, 'claude');
    press(view, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    press(view, { key: '∫', code: 'KeyB', altKey: true, keyCode: 66 });
    press(view, { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
    expect(proc.input()).toBe('\x1bb\x1bb\x1bf');
  });

  it('with optionIsMeta off, Option+key types the macOS character (R4.5)', async () => {
    const harness = await setup();
    harness.ctx.settings.optionIsMeta = false;
    const { view, proc } = await openRunning(harness);
    const b = press(view, { key: '∫', code: 'KeyB', altKey: true, keyCode: 66 });
    expect(b.down.defaultPrevented).toBe(true);
    expect(proc.input()).toBe('∫');
    // A dead key (Option+E) is left to the browser's composition: nothing is sent and the event is not prevented.
    const dead = press(view, { key: 'Dead', code: 'KeyE', altKey: true, keyCode: 69 });
    expect(dead.down.defaultPrevented).toBe(false);
    expect(proc.input()).toBe('∫');
    // Arrows keep xterm's default (no ESC b).
    press(view, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    expect(proc.input()).not.toContain('\x1bb');
  });

  it('Cmd+K clears screen and scrollback of the view and the mirror (R4.4)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness);
    proc.emitData('first line\r\nsecond line\r\n');
    await sleep(5);
    await flushTerm(view);
    expect(bufferText(view)).toContain('second line');
    const clear = vi.spyOn(view.session!, 'clear');
    const pressed = press(view, { key: 'k', code: 'KeyK', metaKey: true });
    await flushTerm(view);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(pressed.down.defaultPrevented).toBe(true);
    expect(bufferText(view)).not.toContain('first line');
    expect(proc.input()).toBe('');
  });

  it('Cmd+A selects all terminal text; Cmd+C copies the selection; Cmd+C without selection is a no-op (R4.3, R4.4)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness);
    proc.emitData('hello world\r\n');
    await sleep(5);
    await flushTerm(view);
    const noSel = press(view, { key: 'c', code: 'KeyC', metaKey: true });
    expect(noSel.down.defaultPrevented).toBe(true);
    expect(harness.clipboard.writes).toEqual([]);
    press(view, { key: 'a', code: 'KeyA', metaKey: true });
    expect(view.terminal!.hasSelection()).toBe(true);
    // Korean input source: key is "ㅊ" but the physical key is still C.
    press(view, { key: 'ㅊ', code: 'KeyC', metaKey: true, keyCode: 67 });
    await sleep(1);
    expect(harness.clipboard.writes).toHaveLength(1);
    expect(harness.clipboard.writes[0]).toContain('hello world');
    expect(proc.input()).toBe('');
  });

  it('Cmd+V pastes through xterm, with bracketed-paste markers when the program enabled them (R4.3)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'claude');
    harness.clipboard.text = 'one\ntwo';
    press(view, { key: 'v', code: 'KeyV', metaKey: true });
    expect(proc.input()).toBe('one\rtwo');
    proc.emitData('\x1b[?2004h');
    await sleep(5);
    await flushTerm(view);
    proc.writes.length = 0;
    press(view, { key: 'v', code: 'KeyV', metaKey: true });
    expect(proc.input()).toBe('\x1b[200~one\rtwo\x1b[201~');
    // The async web clipboard works too.
    harness.clipboard.async = true;
    proc.writes.length = 0;
    const pressed = press(view, { key: 'v', code: 'KeyV', metaKey: true });
    expect(pressed.down.defaultPrevented).toBe(true);
    await waitFor(() => proc.input().length > 0);
    expect(proc.input()).toBe('\x1b[200~one\rtwo\x1b[201~');
  });

  it('other Cmd shortcuts send nothing and stay unprevented for Obsidian / the app menu (R4.2)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness);
    for (const init of [
      { key: 'p', code: 'KeyP' },
      { key: 'o', code: 'KeyO' },
      { key: 'Backspace', code: 'Backspace' },
      { key: 'ArrowUp', code: 'ArrowUp' },
      { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true },
      { key: 'c', code: 'KeyC', shiftKey: true },
    ]) {
      const pressed = press(view, { ...init, metaKey: true });
      expect(pressed.down.defaultPrevented, init.key).toBe(false);
    }
    expect(proc.input()).toBe('');
  });

  it('terminalCmdAction knows exactly the terminal Cmd keys', () => {
    const ev = (init: KeyboardEventInit) => keyEvent('keydown', { metaKey: true, ...init });
    expect(terminalCmdAction(ev({ key: 'c' }))).toBe('copy');
    expect(terminalCmdAction(ev({ key: 'v' }))).toBe('paste');
    expect(terminalCmdAction(ev({ key: 'a' }))).toBe('select-all');
    expect(terminalCmdAction(ev({ key: 'k' }))).toBe('clear');
    expect(terminalCmdAction(ev({ key: 'w' }))).toBe('close');
    expect(terminalCmdAction(ev({ key: 'ArrowLeft' }))).toBe('line-start');
    expect(terminalCmdAction(ev({ key: 'ArrowRight' }))).toBe('line-end');
    expect(terminalCmdAction(ev({ key: 'ㅈ', code: 'KeyW' }))).toBe('close');
    expect(terminalCmdAction(ev({ key: 'p' }))).toBeNull();
    expect(terminalCmdAction(ev({ key: 'w', shiftKey: true }))).toBeNull();
    expect(terminalCmdAction(ev({ key: 'ArrowLeft', altKey: true }))).toBeNull();
    expect(terminalCmdAction(keyEvent('keydown', { key: 'c' }))).toBeNull();
  });
});

describe('IME guard (R4.1)', () => {
  function router(interceptors: Array<() => Promise<void>> = []) {
    const sent: string[] = [];
    let holds = 0;
    const panel = {
      panelId: 'p',
      profile: 'agy',
      sessionId: undefined,
      state: 'running',
      terminal: undefined,
      sendInput: (d: string) => sent.push(d),
      print: () => {},
      holdInput: () => {
        holds++;
        return () => {};
      },
    } as unknown as TerminalPanelHandle;
    const handler = createKeyRouter({
      optionIsMeta: () => true,
      interceptors: () => interceptors,
      clipboard: new FakeClipboard(),
      close: () => {},
      log: quietLog,
    });
    return { handler, panel, sent, holds: () => holds };
  }

  it('composing events are not consumed, not prevented and start no Enter hold', () => {
    const { handler, panel, sent, holds } = router([async () => {}]);
    for (const init of [
      { key: 'Enter', keyCode: 229, isComposing: true },
      { key: 'Enter', keyCode: 13, isComposing: true },
      { key: 'Process', keyCode: 229 },
      { key: 'Enter', keyCode: 229, shiftKey: true },
      { key: 'ArrowLeft', keyCode: 229, metaKey: true },
      { key: 'ArrowLeft', keyCode: 229, altKey: true },
    ]) {
      for (const type of ['keydown', 'keypress', 'keyup'] as const) {
        const ev = keyEvent(type, init);
        expect(isImeEvent(ev)).toBe(true);
        expect(handler(ev, panel)).toBe(false);
        expect(ev.defaultPrevented).toBe(false);
      }
    }
    expect(sent).toEqual([]);
    expect(holds()).toBe(0);
  });

  /** Replays what macOS Chrome's Korean IME produces for "안녕" + Enter on xterm's textarea. */
  async function typeAnnyeongEnter(textarea: HTMLTextAreaElement, enterInSameTask: boolean): Promise<void> {
    const tick = () => sleep(3);
    const keydown = (isComposing: boolean, key = 'Process') =>
      textarea.dispatchEvent(keyEvent('keydown', { key, keyCode: 229, isComposing }));
    const comp = (type: string, data?: string) => {
      const ev = new Event(type, { bubbles: true });
      if (data !== undefined) Object.defineProperty(ev, 'data', { value: data });
      textarea.dispatchEvent(ev);
    };
    let committed = '';
    const update = (text: string) => {
      comp('compositionupdate', text);
      textarea.value = committed + text;
    };
    keydown(false); // ㅇ
    comp('compositionstart');
    update('ㅇ');
    await tick();
    keydown(true); // ㅏ
    update('아');
    await tick();
    keydown(true); // ㄴ
    update('안');
    await tick();
    keydown(true); // ㄴ — "안" is committed, a new syllable starts
    comp('compositionend', '안');
    committed = '안';
    comp('compositionstart');
    update('ㄴ');
    await tick();
    keydown(true); // ㅕ
    update('녀');
    await tick();
    keydown(true); // ㅇ
    update('녕');
    await tick();
    // Enter: the IME's keydown (229, composing), compositionend, then the real Enter keydown.
    textarea.dispatchEvent(keyEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true }));
    comp('compositionend', '녕');
    if (!enterInSameTask) await tick();
    const enter = keyEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 });
    textarea.dispatchEvent(enter);
    if (!enter.defaultPrevented) {
      textarea.dispatchEvent(keyEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, charCode: 13 }));
    }
    textarea.dispatchEvent(keyEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13 }));
  }

  for (const sameTask of [true, false]) {
    it(`"안녕" + Enter reaches the PTY as "안녕" + exactly one CR (Enter keydown ${sameTask ? 'in the same task' : 'one task later'})`, async () => {
      const harness = await setup();
      const { view, proc } = await openRunning(harness);
      await typeAnnyeongEnter(view.terminal!.textarea!, sameTask);
      await sleep(10);
      expect(proc.input()).toBe('안녕\r');
    });

    it(`with an Enter interceptor (agy hold) the last syllable still precedes the CR (${sameTask ? 'same task' : 'next task'})`, async () => {
      const harness = await setup();
      const gate = deferred();
      harness.ctx.keyboard.onEnterIntercept(() => gate.promise);
      const { view, proc } = await openRunning(harness, 'agy');
      await typeAnnyeongEnter(view.terminal!.textarea!, sameTask);
      await sleep(10);
      // Held: the Enter and, when the IME committed it in the same task, the last syllable before it.
      expect(proc.input()).toBe(sameTask ? '안' : '안녕');
      press(view, { key: 'x', code: 'KeyX' });
      gate.resolve();
      await waitFor(() => proc.input() === '안녕\rx');
    });
  }
});

describe('Enter dispatcher (seam for T9, D31)', () => {
  it('without interceptors Enter goes straight through (no hold, no added latency)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'agy');
    const hold = vi.spyOn(view.session!, 'holdInput');
    press(view, { key: 'Enter', code: 'Enter' });
    expect(proc.input()).toBe('\r');
    expect(hold).not.toHaveBeenCalled();
  });

  it('holds the Enter and later keys until a slow interceptor settles, then sends them in order', async () => {
    const harness = await setup();
    const gate = deferred();
    const seen: string[] = [];
    harness.ctx.keyboard.onEnterIntercept((panel) => {
      seen.push(`${panel.profile}:${panel.state}`);
      return gate.promise;
    });
    const { view, proc } = await openRunning(harness, 'agy');
    press(view, { key: 'h', code: 'KeyH' });
    press(view, { key: 'i', code: 'KeyI' });
    press(view, { key: 'Enter', code: 'Enter' });
    expect(seen).toEqual(['agy:running']);
    // Typed and pasted during the hold: queued behind the Enter.
    press(view, { key: 'a', code: 'KeyA' });
    harness.clipboard.text = 'pasted';
    press(view, { key: 'v', code: 'KeyV', metaKey: true });
    press(view, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true });
    press(view, { key: 'Enter', code: 'Enter', shiftKey: true });
    await sleep(20);
    expect(proc.input()).toBe('hi');
    gate.resolve();
    await waitFor(() => proc.input().length > 2);
    expect(proc.input()).toBe('hi\rapasted\x01\x1b\r');
    // Shift+Enter (a newline, not a submit) did not run the interceptors.
    expect(seen).toHaveLength(1);
  });

  it('a second Enter during the hold queues behind the first (each runs the interceptors)', async () => {
    const harness = await setup();
    const gates = [deferred(), deferred()];
    let calls = 0;
    harness.ctx.keyboard.onEnterIntercept(() => gates[calls++]!.promise);
    const { view, proc } = await openRunning(harness, 'agy');
    press(view, { key: 'Enter', code: 'Enter' });
    press(view, { key: 'b', code: 'KeyB' });
    press(view, { key: 'Enter', code: 'Enter' });
    expect(calls).toBe(2);
    gates[1]!.resolve();
    await sleep(10);
    expect(proc.input()).toBe('');
    gates[0]!.resolve();
    await waitFor(() => proc.input() === '\rb\r');
  });

  it('a stuck interceptor is cut off by the safety cap', async () => {
    const harness = await setup({ keyboard: { enterHoldCapMs: 40 } });
    harness.ctx.keyboard.onEnterIntercept(() => new Promise<void>(() => {}));
    const { view, proc } = await openRunning(harness, 'agy');
    const t0 = Date.now();
    press(view, { key: 'Enter', code: 'Enter' });
    press(view, { key: 'z', code: 'KeyZ' });
    expect(proc.input()).toBe('');
    await waitFor(() => proc.input() === '\rz');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(harness.logs.some((l) => l.includes('Enter interceptors still busy'))).toBe(true);
  });

  it('the default cap is 3 s', async () => {
    expect(ENTER_HOLD_CAP_MS).toBe(3_000);
    vi.useFakeTimers();
    const panel = {} as TerminalPanelHandle;
    let outcome: string | null = null;
    void runEnterInterceptors(panel, [() => new Promise<void>(() => {})], quietLog).then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('cap');
    let fast: string | null = null;
    void runEnterInterceptors(panel, [async () => {}, () => undefined], quietLog).then((o) => (fast = o));
    await vi.advanceTimersByTimeAsync(0);
    expect(fast).toBe('done');
  });

  it('throwing or rejecting interceptors are logged and do not keep the Enter', async () => {
    const harness = await setup();
    harness.ctx.keyboard.onEnterIntercept(() => {
      throw new Error('boom');
    });
    harness.ctx.keyboard.onEnterIntercept(() => Promise.reject(new Error('nope')));
    const { view, proc } = await openRunning(harness, 'agy');
    press(view, { key: 'Enter', code: 'Enter' });
    await waitFor(() => proc.input() === '\r');
    expect(harness.logs.filter((l) => l.includes('Enter interceptor failed'))).toHaveLength(2);
  });

  it('ended panels skip the interceptors: Enter restarts the program (T3)', async () => {
    const harness = await setup();
    const intercept = vi.fn(async () => {});
    harness.ctx.keyboard.onEnterIntercept(intercept);
    const { view, proc } = await openRunning(harness, 'agy');
    proc.exit(0);
    await waitFor(() => view.session?.state === 'exited');
    press(view, { key: 'Enter', code: 'Enter' });
    await waitFor(() => harness.pty.spawned.length === 2);
    expect(intercept).not.toHaveBeenCalled();
  });
});
