import { randomUUID } from 'crypto';
import { PROFILE_IDS, type ProfileId } from '../core/constants';
import { profileCommand, type AiTerminalSettings } from '../settings';
import { AGY_ICON, CLAUDE_ICON } from './icons';

/** Icon per profile (tab header, ribbon menu): custom pixel art for the agents (see icons.ts), Lucide for the shell. */
export const PROFILE_ICONS: Readonly<Record<ProfileId, string>> = {
  claude: CLAUDE_ICON,
  agy: AGY_ICON,
  shell: 'terminal',
};

/** Ribbon icon that opens the profile menu (R1.2). */
export const RIBBON_ICON = 'square-terminal';

export interface LaunchCommand {
  command: string;
  /** The profile's arguments from settings; contributors add bridge / resume flags on top (`SpawnContext.baseArgs`). */
  baseArgs: string[];
}

/**
 * Base command of a profile (D3): the command + arguments from Settings › Profiles. The shell profile defaults to
 * `$SHELL -l`. Nothing else is added here — `--session-id`, `--resume`, `--mcp-config`, `--ide`, `--settings` …
 * come from spawn contributors (T5–T9).
 */
export function launchCommand(settings: AiTerminalSettings, profile: ProfileId): LaunchCommand {
  const { command, args } = profileCommand(settings, profile);
  return { command, baseArgs: args };
}

export function newPanelId(): string {
  return randomUUID();
}

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === 'string' && (PROFILE_IDS as readonly string[]).includes(value);
}
