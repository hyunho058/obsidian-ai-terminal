import { Menu, type Workspace, type WorkspaceLeaf } from 'obsidian';
import { PROFILE_IDS, PROFILE_LABELS, TERMINAL_VIEW_TYPE, type PluginContext, type ProfileId } from '../core';
import { newPanelId, PROFILE_ICONS, RIBBON_ICON } from '../session/profiles';
import type { Placement } from '../settings';
import { TerminalView, type TerminalViewSetState } from './TerminalView';

/** Palette commands (R1.1). Obsidian shows them as "AI Terminal: Open Claude Code" etc. */
export const OPEN_COMMANDS: ReadonlyArray<{ id: string; name: string; profile: ProfileId }> = [
  { id: 'open-claude-code', name: 'Open Claude Code', profile: 'claude' },
  { id: 'open-antigravity', name: 'Open Antigravity', profile: 'agy' },
  { id: 'open-shell', name: 'Open shell', profile: 'shell' },
];

export const RIBBON_TITLE = 'Open AI terminal';

export interface OpenTerminalOptions {
  /** Overrides the placement setting. */
  placement?: Placement;
  /** Focus the terminal after opening (default true). */
  focus?: boolean;
}

/**
 * A new, empty leaf for a terminal panel (D1, R1.3, R1.4): right sidebar → a new tab in the right sidebar (never
 * replaces an open terminal); new tab → a tab in the main area; split below → splits the most recent main-area leaf
 * horizontally.
 */
export function leafForPlacement(workspace: Workspace, placement: Placement): WorkspaceLeaf {
  switch (placement) {
    case 'new-tab':
      return workspace.getLeaf('tab');
    case 'split-below':
      return workspace.getLeaf('split', 'horizontal');
    case 'right-sidebar':
    default:
      return workspace.getRightLeaf(false) ?? workspace.getLeaf('tab');
  }
}

/** Opens a new terminal panel for `profile`, reveals it and focuses the terminal. */
export async function openTerminal(ctx: PluginContext, profile: ProfileId, options: OpenTerminalOptions = {}): Promise<TerminalView | null> {
  const { workspace } = ctx.app;
  const leaf = leafForPlacement(workspace, options.placement ?? ctx.settings.placement);
  const state: TerminalViewSetState = { profile, panelId: newPanelId(), launch: 'new' };
  await leaf.setViewState({ type: TERMINAL_VIEW_TYPE, active: true, state: state as Record<string, unknown> });
  await workspace.revealLeaf(leaf);
  const view = leaf.view instanceof TerminalView ? leaf.view : null;
  if (options.focus !== false) {
    workspace.setActiveLeaf(leaf, { focus: true });
    view?.focusTerminal();
  }
  return view;
}

/** Shows the profile menu of the ribbon icon (R1.2). */
export function showProfileMenu(evt: MouseEvent, open: (profile: ProfileId) => void): Menu {
  const menu = new Menu();
  for (const profile of PROFILE_IDS) {
    menu.addItem((item) =>
      item
        .setTitle(PROFILE_LABELS[profile])
        .setIcon(PROFILE_ICONS[profile])
        .onClick(() => open(profile)),
    );
  }
  menu.showAtMouseEvent(evt);
  return menu;
}

/** Registers the three open commands and the ribbon icon (D2). The restore command is T10's. */
export function registerCommands(ctx: PluginContext, open: (profile: ProfileId) => Promise<unknown>): void {
  const run = (profile: ProfileId): void => {
    void open(profile).catch((err) => ctx.log.error(`opening ${PROFILE_LABELS[profile]} failed`, err));
  };
  for (const cmd of OPEN_COMMANDS) {
    ctx.plugin.addCommand({ id: cmd.id, name: cmd.name, icon: PROFILE_ICONS[cmd.profile], callback: () => run(cmd.profile) });
  }
  ctx.plugin.addRibbonIcon(RIBBON_ICON, RIBBON_TITLE, (evt) => {
    showProfileMenu(evt, run);
  });
}
