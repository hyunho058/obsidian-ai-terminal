import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '../util/log';

/** R10.11 / D35 — printed once per vault in the first Claude panel that starts with the IDE connection on. */
export const DIFF_TOOL_HINT = "Tip: to see Claude's edit diffs here, run /config → Diff tool → terminal (one time).";
/** Claude's global config can hold a long project history; larger files are not read (→ hint). */
export const MAX_CONFIG_BYTES = 32 * 1024 * 1024;
/** A slow disk never delays a panel start longer than this (→ hint). */
export const CONFIG_READ_TIMEOUT_MS = 2000;

/**
 * Claude Code's global config file, where `diffTool` lives (Claude Code 2.1.292): `<configDir>/.config.json` if that
 * legacy file exists, else `<$CLAUDE_CONFIG_DIR or home>/.claude.json` (`.claude-custom-oauth.json` with
 * `CLAUDE_CODE_CUSTOM_OAUTH_URL`). configDir = `$CLAUDE_CONFIG_DIR` or `~/.claude`; a relative value is relative to
 * Claude's cwd (the vault).
 */
export async function claudeGlobalConfigFile(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  home: string = os.homedir(),
): Promise<string> {
  const custom = env.CLAUDE_CONFIG_DIR?.trim() ? path.resolve(cwd, env.CLAUDE_CONFIG_DIR.trim()) : undefined;
  const legacy = path.join(custom ?? path.join(home, '.claude'), '.config.json');
  try {
    if ((await fsp.stat(legacy)).isFile()) return legacy;
  } catch {
    // no legacy file
  }
  const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
  return path.join(custom ?? home, `.claude${suffix}.json`);
}

/**
 * Top-level `diffTool` of a Claude config file, read-only: the value (string), `undefined` when the key is absent,
 * `null` when the file is missing, unreadable, unparsable, larger than `maxBytes` or too slow to read.
 */
export async function readClaudeDiffTool(
  file: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string | undefined | null> {
  const maxBytes = opts.maxBytes ?? MAX_CONFIG_BYTES;
  const read = async (): Promise<string | undefined | null> => {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(file, 'r');
      const st = await handle.stat();
      if (!st.isFile() || st.size > maxBytes) return null;
      const text = await handle.readFile({ encoding: 'utf8' });
      if (Buffer.byteLength(text) > maxBytes) return null;
      const config: unknown = JSON.parse(text);
      if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
      const value = (config as Record<string, unknown>).diffTool;
      return typeof value === 'string' ? value : undefined;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), opts.timeoutMs ?? CONFIG_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface DiffToolHintDeps {
  /** True once the hint was shown in this vault (persisted). */
  isShown(): boolean;
  /** Records "shown" (in memory first, then persisted). */
  markShown(): Promise<void>;
  /** Claude's global config file for the spawn about to happen. */
  configFile(): Promise<string>;
  readDiffTool?: (file: string) => Promise<string | undefined | null>;
  log?: Logger;
}

/**
 * Returns the hint text for the spawn that should show it, else undefined. Shown at most once per vault: concurrent
 * spawns don't both get it, and once shown it is never repeated. `diffTool: "terminal"` → no hint and nothing recorded
 * (checked again on the next Claude spawn). Never throws; Claude's config is only read.
 */
export function createDiffToolHint(deps: DiffToolHintDeps): () => Promise<string | undefined> {
  const read = deps.readDiffTool ?? ((file: string) => readClaudeDiffTool(file));
  let checking = false;
  return async () => {
    if (checking || deps.isShown()) return undefined;
    checking = true;
    try {
      const value = await read(await deps.configFile());
      if (value === 'terminal') return undefined;
      try {
        await deps.markShown();
      } catch (err) {
        deps.log?.warn('could not save that the Diff tool hint was shown', err);
      }
      return DIFF_TOOL_HINT;
    } catch (err) {
      deps.log?.warn('Diff tool hint check failed', err);
      return undefined;
    } finally {
      checking = false;
    }
  };
}
