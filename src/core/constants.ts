/** Plugin id — must match manifest.json. */
export const PLUGIN_ID = 'obsidian-ai-terminal';

/** View type of every terminal panel (registered by T3; T4/T6 use it to recognise terminal leaves). */
export const TERMINAL_VIEW_TYPE = 'ai-terminal';

export type ProfileId = 'claude' | 'agy' | 'shell';

export const PROFILE_IDS: readonly ProfileId[] = ['claude', 'agy', 'shell'];

/** User-facing names, e.g. "Claude Code is still running — stop it and close?". */
export const PROFILE_LABELS: Readonly<Record<ProfileId, string>> = {
  claude: 'Claude Code',
  agy: 'Antigravity',
  shell: 'Shell',
};

/** Profiles that run an AI CLI (snapshots, bridge); the shell profile never does. */
export function isAiProfile(profile: ProfileId): profile is 'claude' | 'agy' {
  return profile !== 'shell';
}
