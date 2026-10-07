// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeState, type BridgeChange } from '../../src/bridge/state';
import { createLogger } from '../../src/util/log';
import { createBridgeEnv, silentSink, type BridgeEnv } from './helpers';

const TEXT = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
let env: BridgeEnv;
let state: BridgeState;
let changes: BridgeChange[];

beforeEach(() => {
  vi.useFakeTimers();
  env = createBridgeEnv();
  state = new BridgeState({ app: env.obsidianApp, vaultPath: '/vault', log: createLogger('t', silentSink()), debounceMs: 300 });
  state.start();
  changes = [];
  state.onChange((c) => changes.push(c));
});

afterEach(() => {
  state.dispose();
  vi.useRealTimers();
});

describe('bridgeState.onChange (debounced 300 ms)', () => {
  it('fires once, 300 ms after the selection stops changing, with 0- and 1-based positions', () => {
    const x = env.addNote('Notes/X.md', TEXT);
    env.focus(x.leaf);
    for (let i = 0; i < 5; i++) {
      x.editor.setSelection({ line: 2, ch: 0 }, { line: 2 + i, ch: 4 });
      state.editorActivity();
      vi.advanceTimersByTime(100);
    }
    expect(changes).toHaveLength(0);
    vi.advanceTimersByTime(199);
    expect(changes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      path: 'Notes/X.md',
      selection: {
        path: 'Notes/X.md',
        absolutePath: '/vault/Notes/X.md',
        text: 'line 3\nline 4\nline 5\nline 6\nline',
        from: { line: 2, ch: 0 },
        to: { line: 6, ch: 4 },
        fromLine: 3,
        toLine: 7,
        isEmpty: false,
      },
    });
  });

  it('R10.5: focusing a terminal never fires (no empty selection), and unchanged state is not re-sent', () => {
    const x = env.addNote('X.md', TEXT);
    env.focus(x.leaf);
    x.editor.setSelection({ line: 0, ch: 0 }, { line: 2, ch: 6 });
    state.editorActivity();
    vi.advanceTimersByTime(300);
    expect(changes).toHaveLength(1);
    env.focus(env.addTerminal('right'));
    state.editorActivity(); // e.g. a CodeMirror blur update
    vi.advanceTimersByTime(5000);
    expect(changes).toHaveLength(1);
    env.focus(x.leaf); // back to the same note, same selection
    vi.advanceTimersByTime(5000);
    expect(changes).toHaveLength(1);
  });

  it('closing the note does not fire; focusing another note fires for it', () => {
    const x = env.addNote('X.md', TEXT);
    const y = env.addNote('Y.md', 'y');
    env.focus(x.leaf);
    vi.advanceTimersByTime(300);
    expect(changes.map((c) => c.path)).toEqual(['X.md']);
    x.leaf.detach();
    vi.advanceTimersByTime(1000);
    expect(changes).toHaveLength(1);
    env.focus(y.leaf);
    vi.advanceTimersByTime(300);
    expect(changes.map((c) => c.path)).toEqual(['X.md', 'Y.md']);
    expect(changes[1]!.selection.isEmpty).toBe(true);
  });

  it('a cursor move in the note (deselect) fires with isEmpty', () => {
    const x = env.addNote('X.md', TEXT);
    env.focus(x.leaf);
    x.editor.setSelection({ line: 1, ch: 0 }, { line: 1, ch: 4 });
    state.editorActivity();
    vi.advanceTimersByTime(300);
    x.editor.setCursor({ line: 5, ch: 1 });
    state.editorActivity();
    vi.advanceTimersByTime(300);
    expect(changes.map((c) => c.selection.isEmpty)).toEqual([false, true]);
    expect(changes[1]!.selection).toMatchObject({ text: '', fromLine: 6, toLine: 6 });
  });

  it('nothing fires before a note was focused, and nothing after dispose', () => {
    state.editorActivity();
    vi.advanceTimersByTime(1000);
    expect(changes).toHaveLength(0);
    const x = env.addNote('X.md', TEXT);
    env.focus(x.leaf);
    state.dispose();
    vi.advanceTimersByTime(1000);
    expect(changes).toHaveLength(0);
  });

  it('the CodeMirror update listener reports selection and document changes', () => {
    const spy = vi.spyOn(state, 'editorActivity');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state: EditorState.create({ doc: 'hello world', extensions: [state.editorExtension()] }), parent });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(spy).toHaveBeenCalledTimes(1);
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(spy).toHaveBeenCalledTimes(2);
    view.dispatch({ effects: [] });
    expect(spy).toHaveBeenCalledTimes(2);
    view.destroy();
  });
});
