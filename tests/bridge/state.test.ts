import { afterEach, describe, expect, it } from 'vitest';
import { BridgeState } from '../../src/bridge/state';
import { createLogger } from '../../src/util/log';
import { createBridgeEnv, silentSink, type BridgeEnv } from './helpers';

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
const states: BridgeState[] = [];

function setup(): { env: BridgeEnv; state: BridgeState } {
  const env = createBridgeEnv();
  const state = new BridgeState({ app: env.obsidianApp, vaultPath: '/vault', log: createLogger('t', silentSink()), debounceMs: 300 });
  state.start();
  states.push(state);
  return { env, state };
}

afterEach(() => {
  for (const s of states.splice(0)) s.dispose();
});

describe('last note editor tracking (D24)', () => {
  it('R8.1: the selection survives moving focus to a terminal', () => {
    const { env, state } = setup();
    const x = env.addNote('Notes/X.md', LINES);
    const term = env.addTerminal('right');
    env.focus(x.leaf);
    x.editor.setSelection({ line: 2, ch: 0 }, { line: 4, ch: 6 });
    env.focus(term);
    expect(state.getSelection()).toEqual({ path: 'Notes/X.md', text: 'line 3\nline 4\nline 5', fromLine: 3, toLine: 5 });
  });

  it('reads a selection made backwards and keeps reading it while blurred', () => {
    const { env, state } = setup();
    const x = env.addNote('Notes/X.md', LINES);
    env.focus(x.leaf);
    env.focus(env.addTerminal('main'));
    x.editor.setSelection({ line: 9, ch: 4 }, { line: 7, ch: 0 });
    expect(state.getSelection()).toEqual({ path: 'Notes/X.md', text: 'line 8\nline 9\nline', fromLine: 8, toLine: 10 });
  });

  it('a selection that ends at the start of a line does not count that line', () => {
    const { env, state } = setup();
    const x = env.addNote('A.md', LINES);
    env.focus(x.leaf);
    x.editor.setSelection({ line: 2, ch: 0 }, { line: 5, ch: 0 });
    expect(state.getSelection()).toMatchObject({ fromLine: 3, toLine: 5 });
  });

  it('cursor only → empty text with the path and a reason', () => {
    const { env, state } = setup();
    const x = env.addNote('A.md', LINES);
    env.focus(x.leaf);
    x.editor.setCursor({ line: 4, ch: 2 });
    const sel = state.getSelection();
    expect(sel).toMatchObject({ text: '', path: 'A.md' });
    expect((sel as { reason: string }).reason).toMatch(/Nothing is selected in A\.md \(cursor on line 5\)/);
  });

  it('R8.2: get_active_note returns the last note editor with a 1-based cursor line', () => {
    const { env, state } = setup();
    const x = env.addNote('Notes/X.md', LINES);
    env.focus(x.leaf);
    x.editor.setCursor({ line: 11, ch: 3 });
    env.focus(env.addTerminal('right'));
    expect(state.getActiveNote()).toEqual({ path: 'Notes/X.md', content: LINES, cursorLine: 12 });
  });

  it('returns live editor content (unsaved edits)', () => {
    const { env, state } = setup();
    const x = env.addNote('A.md', 'old');
    env.focus(x.leaf);
    x.editor.setValue('new text');
    expect(state.getActiveNote()).toMatchObject({ content: 'new text' });
  });

  it('R8.3: no note focused yet → empty results with a reason (terminal focus does not count)', () => {
    const { env, state } = setup();
    env.addNote('A.md', 'a');
    env.focus(env.addTerminal('right'));
    const note = state.getActiveNote();
    expect(note).toMatchObject({ empty: true });
    expect((note as { reason: string }).reason).toMatch(/No note has been focused/);
    const sel = state.getSelection();
    expect(sel).toMatchObject({ text: '' });
    expect((sel as { reason: string }).reason).toMatch(/No note has been focused/);
    expect(state.currentSelection()).toBeNull();
  });

  it('picks up the note that is active when the plugin starts', async () => {
    const env = createBridgeEnv();
    const x = env.addNote('A.md', 'a');
    env.focus(x.leaf);
    const state = new BridgeState({ app: env.obsidianApp, vaultPath: '/vault', log: createLogger('t', silentSink()) });
    states.push(state);
    state.start();
    await Promise.resolve();
    expect(state.getActiveNote()).toMatchObject({ path: 'A.md' });
  });

  it('closing the last note leaf forgets it; focusing another note tracks that one', () => {
    const { env, state } = setup();
    const a = env.addNote('A.md', 'a');
    const b = env.addNote('B.md', 'b');
    env.focus(a.leaf);
    env.focus(env.addTerminal('right'));
    a.leaf.detach();
    const note = state.getActiveNote();
    expect(note).toMatchObject({ empty: true });
    expect((note as { reason: string }).reason).toMatch(/closed/);
    expect(state.getSelection()).toMatchObject({ text: '' });
    env.focus(b.leaf);
    expect(state.getActiveNote()).toMatchObject({ path: 'B.md' });
  });

  it('a leaf removed without a layout-change is still detected at read time', () => {
    const { env, state } = setup();
    const a = env.addNote('A.md', 'a');
    env.focus(a.leaf);
    env.app.workspace.removeLeaf(a.leaf);
    expect(state.getActiveNote()).toMatchObject({ empty: true });
  });

  it('follows the file when the same leaf navigates to another note', async () => {
    const { env, state } = setup();
    const a = env.addNote('A.md', 'a');
    env.app.vault.addFile('B.md', 'b');
    env.focus(a.leaf);
    await a.leaf.openFile(env.app.vault.getFileByPath('B.md')!);
    expect(state.getActiveNote()).toMatchObject({ path: 'B.md', content: 'b' });
  });
});

describe('list_open_notes (R8.4)', () => {
  it('lists note leaves in order with the last focused one active; skips terminals, dedupes, includes deferred tabs', () => {
    const { env, state } = setup();
    const a = env.addNote('A.md', 'a');
    env.addTerminal('right');
    const b = env.addNote('B.md', 'b');
    env.addNote('A.md', 'a', 'left');
    env.addDeferredNote('C.md', 'c');
    env.focus(a.leaf);
    env.focus(b.leaf);
    env.focus(env.app.workspace.leaves[1]!);
    expect(state.listOpenNotes()).toEqual([
      { path: 'A.md', active: false },
      { path: 'B.md', active: true },
      { path: 'C.md', active: false },
    ]);
  });

  it('no active entry before any note was focused', () => {
    const { env, state } = setup();
    env.addNote('A.md');
    expect(state.listOpenNotes()).toEqual([{ path: 'A.md', active: false }]);
  });
});

describe('get_links (R8.6)', () => {
  it('returns outgoing links and backlinks from resolvedLinks', () => {
    const { env, state } = setup();
    for (const p of ['A.md', 'B.md', 'C.md', 'D.md']) env.app.vault.addFile(p, '');
    env.app.metadataCache.resolvedLinks = { 'A.md': { 'B.md': 1 }, 'B.md': {}, 'C.md': { 'A.md': 2, 'D.md': 1 }, 'D.md': {} };
    expect(state.getLinks('A.md')).toEqual({ outgoing: ['B.md'], backlinks: ['C.md'] });
    expect(state.getLinks('D')).toEqual({ outgoing: [], backlinks: ['C.md'] });
  });

  it('missing note, folder and paths outside the vault are errors', () => {
    const { env, state } = setup();
    env.app.vault.addFile('A.md', '');
    expect(() => state.getLinks('Nope.md')).toThrow(/Note not found: "Nope\.md"/);
    expect(() => state.getLinks('../A.md')).toThrow(/leaves the vault/);
    expect(() => state.getLinks('/vault/A.md')).toThrow(/Absolute paths/);
  });
});
