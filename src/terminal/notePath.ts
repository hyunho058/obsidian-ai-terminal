import type { TFile, Workspace } from 'obsidian';
import type { PluginContext, ProfileId } from '../core';
import { notice } from '../util/log';
import type { TerminalView } from './TerminalView';

/** Palette command: "AI Terminal: Send note path to terminal". */
export const SEND_NOTE_PATH_COMMAND = { id: 'send-note-path', name: 'Send note path to terminal' } as const;

export const NO_NOTE_NOTICE = 'Click into a note first, then send its path.';
export const NO_TERMINAL_NOTICE = 'Open Claude Code or Antigravity first, then send the note path.';
export const notRunningNotice = (label: string): string => `${label} is not running. Press Enter in its panel to restart it.`;

/** Characters a shell word may hold without quotes. */
const SHELL_SAFE = /^[A-Za-z0-9_./@%+=:,-]+$/;

/**
 * The text that names a vault file in a terminal of `profile`, with a space on both sides so it joins whatever is
 * typed already. The AIs get an @ mention (Claude Code reads the file; quoted when the path has spaces, which Claude
 * Code accepts as `@"…"`); the shell gets a quoted path (it starts in the vault folder).
 */
export function notePathText(profile: ProfileId, path: string): string {
  if (profile === 'shell') return ` ${SHELL_SAFE.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`} `;
  return /\s/.test(path) ? ` @"${path}" ` : ` @${path} `;
}

/**
 * Types the open note's path into a terminal panel (as a paste, so nothing is submitted) and focuses that panel.
 * `file` is the active note (Obsidian's `getActiveFile`, which still names the last note while a terminal is focused);
 * `target` is the terminal to type into. Shows a notice and returns false when either is missing or the program in
 * the panel is not running.
 */
export async function sendNotePath(workspace: Workspace, file: TFile | null, target: TerminalView | undefined): Promise<boolean> {
  if (!file) {
    notice(NO_NOTE_NOTICE);
    return false;
  }
  const term = target?.terminal;
  if (!target || !term) {
    notice(NO_TERMINAL_NOTICE);
    return false;
  }
  if (!target.isRunning()) {
    notice(notRunningNotice(target.label));
    return false;
  }
  term.paste(notePathText(target.profile, file.path));
  await workspace.revealLeaf(target.leaf);
  workspace.setActiveLeaf(target.leaf, { focus: true });
  target.focusTerminal();
  return true;
}

/** Registers the command; `target` picks the terminal (the focused one, else the last focused, else the newest). */
export function registerSendNotePath(ctx: PluginContext, target: () => TerminalView | undefined): void {
  const { workspace } = ctx.app;
  ctx.plugin.addCommand({
    ...SEND_NOTE_PATH_COMMAND,
    icon: 'at-sign',
    callback: () => {
      void sendNotePath(workspace, workspace.getActiveFile(), target()).catch((err) => ctx.log.error('sending the note path failed', err));
    },
  });
}
