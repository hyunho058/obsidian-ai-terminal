// @vitest-environment happy-dom
// TT5 — acceptance tests for R5 (specs/solarized-terminal-colors/spec.md): open panels switch to and stay on
// Solarized without restarting (D5, D6). R5.4 is manual and has no automated test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '../session/helpers';
import { makeViewHarness, type ViewHarness } from './helpers';

let h: ViewHarness | null = null;

beforeEach(() => {
  document.body.className = '';
});

afterEach(() => {
  h?.runtime.unload();
  h = null;
  document.body.className = '';
  vi.restoreAllMocks();
});

type TerminalColorsValue = ViewHarness['ctx']['settings']['terminalColors'];

async function setup(): Promise<ViewHarness> {
  h = await makeViewHarness();
  return h;
}

async function openRunningShell(harness: ViewHarness) {
  const view = (await harness.terminals.open('shell'))!;
  await waitFor(() => view.session?.state === 'running');
  return { view, proc: harness.pty.last };
}

async function setColors(harness: ViewHarness, value: string) {
  harness.ctx.settings.terminalColors = value as TerminalColorsValue;
  await harness.ctx.saveSettings();
}

function containerOf(view: { containerEl: HTMLElement }): HTMLElement {
  const host = view.containerEl.querySelector('.ai-terminal-container') as HTMLElement | null;
  expect(host).not.toBeNull();
  return host!;
}

describe('R5: open panels switch to and stay on Solarized without restarting', () => {
  it('R5.1: setting change to solarized-dark re-colors an open panel and its surround without respawning', async () => {
    const harness = await setup();
    await setColors(harness, 'obsidian');
    const { view, proc } = await openRunningShell(harness);
    const host = containerOf(view);
    const spawnedBefore = [...harness.pty.spawned];

    await setColors(harness, 'solarized-dark');

    expect(view.terminal!.options.theme!.background).toBe('#002b36');
    expect(host.style.backgroundColor).not.toBe('');
    expect(harness.pty.spawned).toEqual(spawnedBefore);
    expect(harness.pty.last).toBe(proc);
  });

  it('R5.2: Obsidian switching to its dark theme (css-change) does not override solarized-light', async () => {
    const harness = await setup();
    await setColors(harness, 'solarized-light');
    const { view } = await openRunningShell(harness);
    expect(view.terminal!.options.theme!.background).toBe('#fdf6e3');

    document.body.classList.add('theme-dark');
    harness.app.workspace.trigger('css-change');

    expect(view.terminal!.options.theme!.background).toBe('#fdf6e3');
  });

  it('R5.3: back to Follow Obsidian theme clears the fixed Solarized surround', async () => {
    const harness = await setup();
    await setColors(harness, 'solarized-dark');
    const { view } = await openRunningShell(harness);
    const host = containerOf(view);
    expect(view.terminal!.options.theme!.background).toBe('#002b36');

    await setColors(harness, 'obsidian');

    expect(view.terminal!.options.theme!.background).not.toBe('#002b36');
    expect(host.style.backgroundColor).toBe('');
  });
});
