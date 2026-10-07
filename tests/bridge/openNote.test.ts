import { afterEach, describe, expect, it } from 'vitest';
import { BridgeState } from '../../src/bridge/state';
import { createLogger } from '../../src/util/log';
import { addFolder, createBridgeEnv, silentSink, type BridgeEnv } from './helpers';

const TWENTY = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n');
const states: BridgeState[] = [];

function setup(): { env: BridgeEnv; state: BridgeState } {
  const env = createBridgeEnv();
  const state = new BridgeState({ app: env.obsidianApp, vaultPath: '/vault', log: createLogger('t', silentSink()) });
  state.start();
  states.push(state);
  return { env, state };
}

afterEach(() => {
  for (const s of states.splice(0)) s.dispose();
});

describe('open_note (R8.5, R8.7)', () => {
  it('opens in the main area at the line, without activating it, while the terminal is in the right sidebar', async () => {
    const { env, state } = setup();
    const m = env.addNote('M.md', 'm');
    env.app.vault.addFile('Projects/a.md', TWENTY);
    const term = env.addTerminal('right');
    env.focus(m.leaf);
    env.focus(term);
    const res = await state.openNote('Projects/a.md', 10);
    expect(res).toEqual({ opened: 'Projects/a.md', line: 10 });
    const call = env.app.openFileCalls.at(-1)!;
    expect(call.path).toBe('Projects/a.md');
    expect(call.leaf.side).toBe('main');
    expect(call.leaf).toBe(m.leaf);
    expect(call.openState).toEqual({ active: false, eState: { line: 9 } });
    expect(env.revealed).toEqual([m.leaf]);
    expect(env.app.workspace.activeLeaf).toBe(term);
  });

  it('reuses a main-area leaf that already shows the note', async () => {
    const { env, state } = setup();
    const m = env.addNote('M.md', 'm');
    const a = env.addNote('Projects/a.md', TWENTY);
    env.focus(a.leaf);
    env.focus(m.leaf);
    await state.openNote('Projects/a.md');
    expect(env.app.openFileCalls.at(-1)).toMatchObject({ leaf: a.leaf, openState: { active: false, eState: {} } });
  });

  it('never opens in a sidebar, even when the note is only open there', async () => {
    const { env, state } = setup();
    env.addNote('Projects/a.md', TWENTY, 'right');
    const m = env.addNote('M.md', 'm');
    env.focus(m.leaf);
    await state.openNote('Projects/a.md');
    expect(env.app.openFileCalls.at(-1)!.leaf.side).toBe('main');
  });

  it('opens a new main-area tab when the most recent main leaf is a terminal or pinned', async () => {
    const { env, state } = setup();
    env.app.vault.addFile('Projects/a.md', TWENTY);
    const term = env.addTerminal('main');
    env.focus(term);
    await state.openNote('Projects/a.md');
    expect(env.newTabs).toHaveLength(1);
    expect(env.app.openFileCalls.at(-1)!.leaf).toBe(env.newTabs[0]);
    expect(term.view?.getViewType()).toBe('ai-terminal');

    const p = env.addNote('P.md', 'p');
    p.leaf.setPinned(true);
    env.focus(p.leaf);
    await state.openNote('Projects/a.md', 2);
    expect(env.app.openFileCalls.at(-1)!.leaf).not.toBe(p.leaf);
  });

  it('clamps the line to the end of the note and accepts a path without .md', async () => {
    const { env, state } = setup();
    env.app.vault.addFile('Projects/a.md', TWENTY);
    env.focus(env.addNote('M.md', 'm').leaf);
    expect(await state.openNote('Projects/a', 999)).toEqual({ opened: 'Projects/a.md', line: 20 });
    expect(env.app.openFileCalls.at(-1)!.openState?.eState).toEqual({ line: 19 });
  });

  it('missing note, folder, bad line and paths outside the vault are errors and open nothing', async () => {
    const { env, state } = setup();
    env.app.vault.addFile('A.md', 'a');
    addFolder(env, 'Projects');
    env.focus(env.addNote('M.md', 'm').leaf);
    await expect(state.openNote('Projects/missing.md', 10)).rejects.toThrow(/Note not found/);
    await expect(state.openNote('Projects')).rejects.toThrow(/is a folder/);
    await expect(state.openNote('../secret.md')).rejects.toThrow(/leaves the vault/);
    await expect(state.openNote('/etc/hosts')).rejects.toThrow(/Absolute paths/);
    await expect(state.openNote('A.md', 0)).rejects.toThrow(/line must be/);
    await expect(state.openNote('A.md', 1.5)).rejects.toThrow(/line must be/);
    expect(env.app.openFileCalls).toEqual([]);
    expect(env.revealed).toEqual([]);
  });
});
