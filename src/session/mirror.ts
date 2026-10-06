import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { IDisposable } from '@xterm/headless';

/** Serialized screen of a session, written into a fresh xterm of `cols`×`rows` to restore it (D34). */
export interface MirrorSnapshot {
  data: string;
  cols: number;
  rows: number;
}

export interface MirrorOptions {
  cols: number;
  rows: number;
  scrollback: number;
}

type MouseEncoding = 'default' | 'sgr' | 'sgr-pixels';

/**
 * Terminal state that `@xterm/addon-serialize` 0.14 does not write back (verified in tests/session/mirror.test.ts):
 * cursor visibility (DECTCEM), the mouse report encoding (SGR 1006 / 1016) and the cursor shape (DECSCUSR).
 * Tracked through public parser hooks; every hook returns false so xterm's own handler still runs.
 */
class ExtraModes {
  cursorHidden = false;
  mouseEncoding: MouseEncoding = 'default';
  /** Last non-zero DECSCUSR parameter (null = terminal default). */
  cursorStyle: number | null = null;
  private readonly hooks: IDisposable[] = [];

  constructor(term: HeadlessTerminal) {
    const decset = (on: boolean) => (params: (number | number[])[]): boolean => {
      for (const p of params) this.applyPrivateMode(typeof p === 'number' ? p : (p[0] ?? -1), on);
      return false;
    };
    this.hooks.push(
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, decset(true)),
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, decset(false)),
      term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
        const first = params[0];
        const n = first === undefined ? 1 : typeof first === 'number' ? first : (first[0] ?? 1);
        this.cursorStyle = n === 0 ? null : n;
        return false;
      }),
      // DECSTR (soft reset): cursor shown, cursor shape back to default; mouse encoding is kept.
      term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
        this.cursorHidden = false;
        this.cursorStyle = null;
        return false;
      }),
      // RIS (full reset).
      term.parser.registerEscHandler({ final: 'c' }, () => {
        this.reset();
        return false;
      }),
    );
  }

  private applyPrivateMode(mode: number, on: boolean): void {
    if (mode === 25) this.cursorHidden = !on;
    else if (mode === 1006) this.mouseEncoding = on ? 'sgr' : 'default';
    else if (mode === 1016) this.mouseEncoding = on ? 'sgr-pixels' : 'default';
  }

  reset(): void {
    this.cursorHidden = false;
    this.mouseEncoding = 'default';
    this.cursorStyle = null;
  }

  /** Escape sequences that re-apply the tracked state on top of `SerializeAddon.serialize()`. */
  sequences(): string {
    let out = '';
    if (this.cursorHidden) out += '\x1b[?25l';
    if (this.mouseEncoding === 'sgr') out += '\x1b[?1006h';
    else if (this.mouseEncoding === 'sgr-pixels') out += '\x1b[?1016h';
    if (this.cursorStyle !== null) out += `\x1b[${this.cursorStyle} q`;
    return out;
  }

  dispose(): void {
    for (const h of this.hooks.splice(0)) h.dispose();
  }
}

/**
 * Headless copy of a session's screen (D34): receives every output byte, is resized together with the PTY and
 * can be serialized into a fresh xterm (screen, scrollback, alternate screen and terminal modes). Its own
 * replies to terminal queries are discarded — the visible xterm answers them.
 */
export class TerminalMirror {
  private readonly term: HeadlessTerminal;
  private readonly serializer = new SerializeAddon();
  private readonly extra: ExtraModes;
  private disposed = false;

  constructor(opts: MirrorOptions) {
    this.term = new HeadlessTerminal({
      cols: clamp(opts.cols, 80),
      rows: clamp(opts.rows, 24),
      scrollback: opts.scrollback,
      allowProposedApi: true,
    });
    // Same character widths as the visible terminal (Korean, emoji), so cursor positions agree after a restore.
    this.term.loadAddon(new Unicode11Addon() as unknown as Parameters<HeadlessTerminal['loadAddon']>[0]);
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(this.serializer as unknown as Parameters<HeadlessTerminal['loadAddon']>[0]);
    this.extra = new ExtraModes(this.term);
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** The headless terminal (tests / diagnostics). */
  get terminal(): HeadlessTerminal {
    return this.term;
  }

  write(data: string | Uint8Array): void {
    if (!this.disposed) this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const c = clamp(cols, this.term.cols);
    const r = clamp(rows, this.term.rows);
    if (c !== this.term.cols || r !== this.term.rows) this.term.resize(c, r);
  }

  setScrollback(lines: number): void {
    if (!this.disposed) this.term.options.scrollback = lines;
  }

  /** Clears the scrollback and the screen except the cursor line (like xterm's `clear()`), after pending writes. */
  clear(): void {
    if (this.disposed) return;
    this.term.write('', () => {
      if (!this.disposed) this.term.clear();
    });
  }

  /** Resolves once every write queued so far has been parsed. */
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.term.write('', resolve));
  }

  /** True while the program uses the alternate screen (after `flush()`). */
  isAltScreen(): boolean {
    return !this.disposed && this.term.buffer.active.type === 'alternate';
  }

  /** Cursor column on the active screen (after `flush()`). */
  cursorX(): number {
    return this.disposed ? 0 : this.term.buffer.active.cursorX;
  }

  /**
   * Serializes the state after every write queued *before this call* — the serialization runs in the write
   * callback, so output written after the call is not included (the caller replays it separately).
   */
  snapshot(): Promise<MirrorSnapshot> {
    if (this.disposed) return Promise.resolve({ data: '', cols: this.cols, rows: this.rows });
    return new Promise((resolve) => {
      this.term.write('', () => {
        const data = this.disposed ? '' : this.serializer.serialize() + this.extra.sequences();
        resolve({ data, cols: this.term.cols, rows: this.term.rows });
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.extra.dispose();
    this.term.dispose();
  }
}

function clamp(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) return Math.max(1, Math.floor(fallback));
  return Math.min(65535, Math.floor(value));
}
