import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { TerminalMirror } from '../../src/session/mirror';

type Internals = {
  _core: {
    coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } };
    coreMouseService: { activeEncoding: string; activeProtocol: string };
  };
};

function write(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function fresh(cols = 40, rows = 10): HeadlessTerminal {
  return new HeadlessTerminal({ cols, rows, allowProposedApi: true });
}

function state(term: HeadlessTerminal) {
  const core = (term as unknown as Internals)._core;
  return {
    bracketedPaste: term.modes.bracketedPasteMode,
    appCursor: term.modes.applicationCursorKeysMode,
    appKeypad: term.modes.applicationKeypadMode,
    mouse: term.modes.mouseTrackingMode,
    focus: term.modes.sendFocusMode,
    buffer: term.buffer.active.type,
    cursorHidden: core.coreService.isCursorHidden,
    mouseEncoding: core.coreMouseService.activeEncoding,
    cursorStyle: core.coreService.decPrivateModes.cursorStyle,
  };
}

function screenText(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
  return out;
}

const MODES = '\x1b[?2004h\x1b[?1h\x1b=\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l\x1b[5 q';

describe('addon-serialize 0.14 mode coverage (Known Gap, D34)', () => {
  it('restores bracketed paste, application cursor keys, mouse tracking and the alt screen on its own', async () => {
    const src = fresh();
    const ser = new SerializeAddon();
    src.loadAddon(ser as never);
    await write(src, 'normal line\r\n\x1b[?1049h\x1b[Halt screen' + MODES);
    const dst = fresh();
    await write(dst, ser.serialize());
    const before = state(src);
    const after = state(dst);
    expect(after.bracketedPaste).toBe(true);
    expect(after.appCursor).toBe(true);
    expect(after.appKeypad).toBe(true);
    expect(after.mouse).toBe('drag');
    expect(after.focus).toBe(true);
    expect(after.buffer).toBe('alternate');
    // Not covered by the addon — the mirror re-emits these (see below).
    expect(before.cursorHidden).toBe(true);
    expect(after.cursorHidden).toBe(false);
    expect(before.mouseEncoding).toBe('SGR');
    expect(after.mouseEncoding).toBe('DEFAULT');
    expect(before.cursorStyle).toBe('bar');
    expect(after.cursorStyle).toBeUndefined();
  });

  it('TerminalMirror snapshots restore every mode, including the ones the addon misses', async () => {
    const mirror = new TerminalMirror({ cols: 40, rows: 10, scrollback: 1000 });
    mirror.write('normal line\r\n\x1b[?1049h\x1b[Halt screen' + MODES);
    const snap = await mirror.snapshot();
    expect(snap).toMatchObject({ cols: 40, rows: 10 });
    const dst = fresh();
    await write(dst, snap.data);
    expect(state(dst)).toEqual(state(mirror.terminal));
    expect(state(dst)).toMatchObject({ cursorHidden: true, mouseEncoding: 'SGR', cursorStyle: 'bar', buffer: 'alternate' });
    expect(screenText(dst)[0]).toBe('alt screen');
    mirror.dispose();
  });

  it('tracks resets: DECRST, DECSTR and RIS', async () => {
    const mirror = new TerminalMirror({ cols: 20, rows: 5, scrollback: 100 });
    mirror.write('\x1b[?25l\x1b[?1006h\x1b[3 q');
    mirror.write('\x1b[?25h\x1b[?1006l');
    let dst = fresh(20, 5);
    await write(dst, (await mirror.snapshot()).data);
    expect(state(dst)).toMatchObject({ cursorHidden: false, mouseEncoding: 'DEFAULT', cursorStyle: 'underline' });
    mirror.write('\x1b[?25l\x1b[!p');
    dst = fresh(20, 5);
    await write(dst, (await mirror.snapshot()).data);
    expect(state(dst)).toMatchObject({ cursorHidden: false, cursorStyle: undefined });
    mirror.write('\x1b[?1016h\x1b[?25l\x1bc');
    dst = fresh(20, 5);
    await write(dst, (await mirror.snapshot()).data);
    expect(state(dst)).toMatchObject({ cursorHidden: false, mouseEncoding: 'DEFAULT' });
    mirror.dispose();
  });

  it('keeps scrollback and wide characters (Korean, emoji) in the snapshot', async () => {
    const mirror = new TerminalMirror({ cols: 20, rows: 3, scrollback: 100 });
    for (let i = 1; i <= 6; i++) mirror.write(`line ${i}\r\n`);
    mirror.write('한글 😀x');
    await mirror.flush();
    expect(mirror.cursorX()).toBe(8); // 한(2) 글(2) space 😀(2) x
    const dst = new HeadlessTerminal({ cols: 20, rows: 3, scrollback: 100, allowProposedApi: true });
    await write(dst, (await mirror.snapshot()).data);
    const text = screenText(dst);
    expect(text.slice(0, 6)).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6']);
    expect(text).toContain('한글 😀x');
    mirror.dispose();
  });

  it('snapshot excludes output written after the call (replayed separately by the registry)', async () => {
    const mirror = new TerminalMirror({ cols: 20, rows: 3, scrollback: 100 });
    mirror.write('before');
    const pending = mirror.snapshot();
    mirror.write(' after');
    const snap = await pending;
    expect(snap.data).toContain('before');
    expect(snap.data).not.toContain('after');
    mirror.dispose();
  });

  it('resizes and never answers terminal queries', async () => {
    const mirror = new TerminalMirror({ cols: 80, rows: 24, scrollback: 100 });
    const replies: string[] = [];
    mirror.terminal.onData((d) => replies.push(d));
    mirror.resize(90, 30);
    expect([mirror.cols, mirror.rows]).toEqual([90, 30]);
    // The mirror's own replies are produced by xterm but nothing forwards them (the registry never subscribes).
    mirror.write('\x1b[6n\x1b[c');
    await mirror.flush();
    expect(replies.length).toBeGreaterThan(0);
    mirror.dispose();
    expect(() => mirror.write('x')).not.toThrow();
  });
});
