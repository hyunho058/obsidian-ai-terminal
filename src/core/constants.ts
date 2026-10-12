/** Plugin id — must match manifest.json. */
export const PLUGIN_ID = 'ai-terminal';

/**
 * Folder name under `~/.config` and `~/.local/share`. Kept from the plugin's first id, so existing snapshot
 * history and the agy entry's shim path stay valid.
 */
export const DATA_DIR_NAME = 'obsidian-ai-terminal';

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

/** Name of the bridge's MCP server as the AI tools show it (`mcp__obsidian__get_active_note` in Claude Code). */
export const MCP_SERVER_NAME = 'obsidian';

/** Environment variable with the bridge's bearer token for AI panels (Claude, agy's shim, the snapshot hook). */
export const BRIDGE_TOKEN_ENV = 'OBSIDIAN_BRIDGE_TOKEN';

/** Environment variable with the bridge's base URL, `http://127.0.0.1:<port>` — append `/mcp` or a route like `/snapshot`. */
export const BRIDGE_URL_ENV = 'OBSIDIAN_BRIDGE_URL';
