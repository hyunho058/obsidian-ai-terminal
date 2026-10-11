// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_VIEW_TYPE } from '../../src/core';
import { leafForPlacement, OPEN_COMMANDS, RIBBON_TITLE } from '../../src/terminal/commands';
import { TerminalView } from '../../src/terminal/TerminalView';
import { Menu, Workspace } from '../mocks/obsidian';
import { waitFor } from '../session/helpers';
import { makeViewHarness, type ViewHarness } from './helpers';

let h: ViewHarness | null = null;
afterEach(() => {
  h?.runtime.unload();
  h = null;
  Menu.shown = [];
  vi.restoreAllMocks();
});

describe('commands and ribbon (D1–D3, R1.1–R1.4)', () => {
  it('registers "Open Claude Code", "Open Antigravity", "Open shell", "Send note path to terminal" (and leaves the restore command to T10)', async () => {
    h = await makeViewHarness();
    const commands = h.plugin.commands.map((c) => [c.id, c.name]);
    expect(commands).toEqual([
      ['obsidian-ai-terminal:open-claude-code', 'Open Claude Code'],
      ['obsidian-ai-terminal:open-antigravity', 'Open Antigravity'],
      ['obsidian-ai-terminal:open-shell', 'Open shell'],
      ['obsidian-ai-terminal:send-note-path', 'Send note path to terminal'],
    ]);
    expect(OPEN_COMMANDS.map((c) => c.profile)).toEqual(['claude', 'agy', 'shell']);
  });

  it('each command opens its profile in a new right-sidebar tab with focus (R0.1, R0.2, R1.3)', async () => {
    h = await makeViewHarness();
    const harness = h;
    const focus = vi.spyOn(TerminalView.prototype, 'focusTerminal');
    const openCommands = h.plugin.commands.filter((c) => OPEN_COMMANDS.some((o) => c.id.endsWith(`:${o.id}`)));
    expect(openCommands).toHaveLength(3);
    for (const [i, cmd] of openCommands.entries()) {
      cmd.callback!();
      await waitFor(() => harness.pty.calls.length === i + 1);
    }
    const leaves = h.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
    expect(leaves).toHaveLength(3);
    expect(leaves.every((l) => l.side === 'right')).toBe(true);
    expect(new Set(leaves).size).toBe(3);
    expect(leaves.map((l) => (l.view as unknown as TerminalView).profile)).toEqual(['claude', 'agy', 'shell']);
    expect(h.pty.calls.map((c) => c.command)).toEqual(['claude', 'agy', h.ctx.settings.profiles.shell.command]);
    expect(h.pty.calls.every((c) => c.cwd === h!.ctx.vaultPath)).toBe(true);
    expect(h.app.workspace.activeLeaf).toBe(leaves[2]);
    expect(focus).toHaveBeenCalled();
    // Three independent sessions (R1.5).
    expect(new Set(h.sessions.list().map((s) => s.panelId)).size).toBe(3);
  });

  it('"Open Claude Code" puts keyboard focus into the new right-sidebar terminal (R1.3)', async () => {
    h = await makeViewHarness();
    const harness = h;
    // Obsidian keeps every leaf's view in the window's DOM; the mock does not, so attach each new view's container.
    const create = h.app.viewCreators.get(TERMINAL_VIEW_TYPE)!;
    const attached: HTMLElement[] = [];
    h.app.viewCreators.set(TERMINAL_VIEW_TYPE, (leaf) => {
      const view = create(leaf);
      document.body.appendChild(view.containerEl);
      attached.push(view.containerEl);
      return view;
    });
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      h.plugin.commands.find((c) => c.name === 'Open Claude Code')!.callback!();
      await waitFor(() => harness.pty.calls.length === 1);
      const leaves = h.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
      expect(leaves).toHaveLength(1);
      expect(leaves[0]!.side).toBe('right');
      const view = leaves[0]!.view as unknown as TerminalView;
      expect(view.profile).toBe('claude');
      const textarea = view.terminal!.textarea!;
      await waitFor(() => document.activeElement === textarea);
      expect(view.containerEl.contains(document.activeElement)).toBe(true);
      // Typing now goes to the program without a click.
      await waitFor(() => view.session?.state === 'running');
      view.terminal!.input('hi');
      expect(harness.pty.last.input()).toBe('hi');
    } finally {
      for (const el of attached) el.remove();
    }
  });

  it('the ribbon icon shows a profile menu and opens the picked profile (R1.2)', async () => {
    h = await makeViewHarness();
    expect(h.plugin.ribbonIcons).toHaveLength(1);
    const ribbon = h.plugin.ribbonIcons[0]!;
    expect(ribbon.icon).toBe('square-terminal');
    expect(ribbon.title).toBe(RIBBON_TITLE);
    ribbon.callback(new MouseEvent('click'));
    expect(Menu.shown).toHaveLength(1);
    const menu = Menu.shown[0]!;
    expect(menu.items.map((i) => i.title)).toEqual(['Claude Code', 'Antigravity', 'Shell']);
    menu.items[1]!.click();
    await waitFor(() => h!.pty.calls.length === 1);
    expect(h.pty.calls[0]!.command).toBe('agy');
  });

  it('maps placement settings to Obsidian leaves (R1.4)', () => {
    const ws = new Workspace(null as never);
    const right = vi.spyOn(ws, 'getRightLeaf');
    const get = vi.spyOn(ws, 'getLeaf');
    leafForPlacement(ws as never, 'right-sidebar');
    expect(right).toHaveBeenCalledWith(false);
    leafForPlacement(ws as never, 'new-tab');
    expect(get).toHaveBeenLastCalledWith('tab');
    leafForPlacement(ws as never, 'split-below');
    expect(get).toHaveBeenLastCalledWith('split', 'horizontal');
  });

  it('opens with the placement setting: new tab and split below land in the main area', async () => {
    h = await makeViewHarness();
    const get = vi.spyOn(h.app.workspace, 'getLeaf');
    h.ctx.settings.placement = 'new-tab';
    const tab = await h.terminals.open('shell');
    expect(get).toHaveBeenLastCalledWith('tab');
    expect((tab!.leaf as unknown as { side: string }).side).toBe('main');
    h.ctx.settings.placement = 'split-below';
    await h.terminals.open('shell');
    expect(get).toHaveBeenLastCalledWith('split', 'horizontal');
  });

  it('respects edited profile arguments (R1.7)', async () => {
    h = await makeViewHarness();
    h.ctx.settings.profiles.claude.args = '--model sonnet';
    await h.terminals.open('claude');
    await waitFor(() => h!.pty.calls.length === 1);
    expect(h.pty.calls[0]!.args).toEqual(['--model', 'sonnet']);
  });
});
