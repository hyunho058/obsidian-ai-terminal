import type { SpawnContributor } from '../core';
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV } from '../bridge/claudeMcpContributor';
import type { BridgeServerService } from '../bridge/httpServer';
import type { Logger } from '../util/log';

export const SNAPSHOT_HOOK_SCRIPT = 'snapshot_hook.py';
/** Tells the hook which panel the message comes from (for the panel notes). */
export const PANEL_ID_ENV = 'OBSIDIAN_PANEL_ID';
/** Claude Code kills the hook after this many seconds; the hook itself gives up after 10 s. */
export const HOOK_TIMEOUT_S = 15;
const START_WAIT_MS = 3_000;

/** POSIX single-quoting for the hook command (Claude runs it with `sh -c`). */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The session-only settings JSON for `claude --settings=<json>` (D28, D31): a `UserPromptSubmit` command hook. */
export function claudeHookSettings(python: string, hookPath: string): string {
  const command = `${shellQuote(python)} -I ${shellQuote(hookPath)}`;
  return JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }] },
  });
}

/** The user's profile arguments already pass `--settings` (Claude keeps only one): ours would replace theirs. */
export function hasSettingsArg(args: readonly string[]): boolean {
  return args.some((a) => a === '--settings' || a.startsWith('--settings='));
}

export const USER_SETTINGS_NOTICE = '[Snapshots: your --settings argument is kept, so Claude Code messages are not snapshotted]';

export interface ClaudeHookContributorOptions {
  /** Whether Claude panels should get the hook (snapshots not turned off and git works). */
  wantsHook: () => boolean;
  /** The bridge server when the bridge is enabled. */
  getServer: () => BridgeServerService | undefined;
  /** Absolute python3 (D7). */
  resolvePython: () => Promise<string>;
  /** Stable path of the installed hook (`~/.config/obsidian-ai-terminal/snapshot_hook.py`). */
  hookPath: string;
  log?: Logger;
}

/**
 * Spawn contributor for Claude panels (R11.1 `--settings` part): `--settings=<json>` with the snapshot hook, plus the
 * panel id and bridge connection in the environment. Nothing is written to Claude's config. The `=` form keeps the JSON
 * one argument whatever follows.
 */
export function createClaudeHookContributor(o: ClaudeHookContributorOptions): SpawnContributor {
  return async (c) => {
    if (c.profile !== 'claude' || !o.wantsHook()) return;
    if (hasSettingsArg(c.baseArgs)) return { notice: USER_SETTINGS_NOTICE };
    const server = o.getServer();
    if (!server) return;
    if (!server.isRunning() && !(await listensWithin(server, START_WAIT_MS))) return;
    const baseUrl = server.baseUrl;
    if (!baseUrl) return;
    let python: string;
    try {
      python = await o.resolvePython();
    } catch (err) {
      o.log?.warn('no Python for the snapshot hook', err);
      return;
    }
    return {
      args: [`--settings=${claudeHookSettings(python, o.hookPath)}`],
      env: { [PANEL_ID_ENV]: c.panelId, [BRIDGE_URL_ENV]: baseUrl, [BRIDGE_TOKEN_ENV]: server.token },
    };
  };
}

async function listensWithin(server: BridgeServerService, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([server.whenListening().then(() => true, () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
