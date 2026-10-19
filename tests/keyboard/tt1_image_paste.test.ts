// @vitest-environment happy-dom
// TT1 — acceptance tests for spec paste-image R1 (D1, D3, D5): Cmd+V sends Ctrl+V for an image-only clipboard in agent panels.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalClipboard } from '../../src/terminal/keyboard';
import { flushTerm } from '../terminal/helpers';
import { deferred, sleep, waitFor } from '../session/helpers';
import { makeKeyboardHarness, openRunning, press, type KeyboardHarness } from './helpers';

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

const CMD_V = { key: 'v', code: 'KeyV', metaKey: true } as const;

/** A clipboard with custom `readText` and a counting `hasImage` (always true). */
class ScriptedClipboard {
  hasImageCalls = 0;
  /** Whether `onHasImage` saw the read already settled on its first call. */
  firstHasImageAfterResolve: boolean | null = null;
  settled = false;
  constructor(private readonly read: () => string | Promise<string>) {}
  readText(): string | Promise<string> {
    return this.read();
  }
  writeText(_text: string): void {}
  hasImage(): boolean {
    if (this.hasImageCalls === 0) this.firstHasImageAfterResolve = this.settled;
    this.hasImageCalls++;
    return true;
  }
}

describe('TT1 / R1: Cmd+V with an image-only clipboard in agent panels', () => {
  it('R1.1: image-only clipboard in a Claude panel sends exactly \\x16 and prevents the keydown', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'claude');
    harness.clipboard.text = '';
    harness.clipboard.image = true;
    const pressed = press(view, CMD_V);
    expect(pressed.down.defaultPrevented).toBe(true);
    await waitFor(() => proc.input().length > 0);
    await sleep(10);
    expect(proc.input()).toBe('\x16');
  });

  it('R1.2: image-only clipboard in an agy panel sends exactly \\x16', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'agy');
    harness.clipboard.text = '';
    harness.clipboard.image = true;
    press(view, CMD_V);
    await waitFor(() => proc.input().length > 0);
    await sleep(10);
    expect(proc.input()).toBe('\x16');
  });

  it('R1.3: text on the clipboard wins over an image (bracketed paste, whitespace included)', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'claude');
    proc.emitData('\x1b[?2004h');
    await sleep(5);
    await flushTerm(view);
    proc.writes.length = 0;
    harness.clipboard.image = true;

    harness.clipboard.text = 'one\ntwo';
    press(view, CMD_V);
    await waitFor(() => proc.input().length > 0);
    await sleep(10);
    expect(proc.input()).toBe('\x1b[200~one\rtwo\x1b[201~');
    expect(proc.input()).not.toContain('\x16');

    proc.writes.length = 0;
    harness.clipboard.text = ' ';
    press(view, CMD_V);
    await waitFor(() => proc.input().length > 0);
    await sleep(10);
    expect(proc.input()).toBe('\x1b[200~ \x1b[201~');
    expect(proc.input()).not.toContain('\x16');
  });

  it('R1.4: empty text and hasImage() false sends nothing and prevents the keydown', async () => {
    const harness = await setup();
    const { view, proc } = await openRunning(harness, 'claude');
    harness.clipboard.text = '';
    harness.clipboard.image = false;
    const pressed = press(view, CMD_V);
    expect(pressed.down.defaultPrevented).toBe(true);
    await sleep(20);
    expect(proc.input()).toBe('');
  });

  it('R1.4: empty text and a clipboard without a hasImage method sends nothing and prevents the keydown', async () => {
    const clipboard: TerminalClipboard = { readText: () => '', writeText: () => {} };
    const harness = await setup({ keyboard: { clipboard } });
    const { view, proc } = await openRunning(harness, 'claude');
    const pressed = press(view, CMD_V);
    expect(pressed.down.defaultPrevented).toBe(true);
    await sleep(20);
    expect(proc.input()).toBe('');
  });

  it('R1.5: a throwing readText() sends nothing, skips hasImage() and logs "paste failed"', async () => {
    const clipboard = new ScriptedClipboard(() => {
      throw new Error('clipboard unavailable');
    });
    const harness = await setup({ keyboard: { clipboard } });
    const { view, proc } = await openRunning(harness, 'claude');
    press(view, CMD_V);
    await waitFor(() => harness.logs.some((l) => l.includes('paste failed')));
    await sleep(20);
    expect(proc.input()).toBe('');
    expect(clipboard.hasImageCalls).toBe(0);
  });

  it('R1.5: a rejecting readText() sends nothing, skips hasImage() and logs "paste failed"', async () => {
    const clipboard = new ScriptedClipboard(() => Promise.reject(new Error('clipboard unavailable')));
    const harness = await setup({ keyboard: { clipboard } });
    const { view, proc } = await openRunning(harness, 'claude');
    press(view, CMD_V);
    await waitFor(() => harness.logs.some((l) => l.includes('paste failed')));
    await sleep(20);
    expect(proc.input()).toBe('');
    expect(clipboard.hasImageCalls).toBe(0);
  });

  it("R1.6: an async readText() resolving to '' is awaited before hasImage(), then \\x16 is sent", async () => {
    let resolveRead!: (text: string) => void;
    const clipboard = new ScriptedClipboard(
      () =>
        new Promise<string>((r) => {
          resolveRead = r;
        }),
    );
    const harness = await setup({ keyboard: { clipboard } });
    const { view, proc } = await openRunning(harness, 'claude');
    press(view, CMD_V);
    await sleep(20);
    expect(clipboard.hasImageCalls).toBe(0);
    expect(proc.input()).toBe('');
    clipboard.settled = true;
    resolveRead('');
    await waitFor(() => proc.input().length > 0);
    await sleep(10);
    expect(clipboard.firstHasImageAfterResolve).toBe(true);
    expect(proc.input()).toBe('\x16');
  });

  it("R1.6: an async readText() resolving to 'hi' pastes hi and no \\x16", async () => {
    const clipboard = new ScriptedClipboard(() => Promise.resolve('hi'));
    const harness = await setup({ keyboard: { clipboard } });
    const { view, proc } = await openRunning(harness, 'claude');
    press(view, CMD_V);
    await waitFor(() => proc.input().length > 0);
    await sleep(10);
    expect(proc.input()).toBe('hi');
    expect(proc.input()).not.toContain('\x16');
  });

  it('R1.7: the \\x16 queues behind a held Enter and follows it after release', async () => {
    const harness = await setup();
    const gate = deferred();
    harness.ctx.keyboard.onEnterIntercept(() => gate.promise);
    const { view, proc } = await openRunning(harness, 'claude');
    harness.clipboard.text = '';
    harness.clipboard.image = true;
    press(view, { key: 'Enter', code: 'Enter' });
    press(view, CMD_V);
    await sleep(20);
    expect(proc.input()).toBe('');
    gate.resolve();
    await waitFor(() => proc.input().length >= 2);
    await sleep(10);
    expect(proc.input()).toBe('\r\x16');
  });
});
