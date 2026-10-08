import * as fs from 'fs';
import type { FeatureModule, PluginContext } from '../core';
import { profileCommand } from '../settings';
import { notice, type Logger } from '../util/log';
import { AGY_NOT_FOUND, AgyConfig, SHIM_SCRIPT, type AgyConfigOptions, type EnsureOutcome, type RemoveOutcome } from './agyConfig';
import { createAgyEnvContributor } from './agyEnvContributor';

/** The `agyBridge` service: the global agy `obsidian` entry (D28). */
export interface AgyBridgeService {
  /** Stable path of the installed shim (`~/.config/obsidian-ai-terminal/mcp_shim.py`). */
  readonly shimPath: string;
  /** Result of the last ensure / remove, if any finished. */
  readonly lastOutcome: EnsureOutcome | RemoveOutcome | undefined;
  /** Registers / updates the entry (`agy mcp list` → `agy mcp add` if needed). Never rejects. */
  ensure(): Promise<EnsureOutcome>;
  /** Removes the entry if this plugin created it. Never rejects. */
  remove(): Promise<RemoveOutcome>;
}

declare module '../core/services' {
  interface ServiceMap {
    agyBridge: AgyBridgeService;
  }
}

export const AGY_READY_TIMEOUT_MS = 10_000;
/** Settings text fields save on every keystroke; re-check the entry once typing has settled. */
const RECHECK_DELAY_MS = 2_000;

export interface AgyModuleOptions extends Pick<AgyConfigOptions, 'run' | 'lockStaleMs' | 'lockWaitMs' | 'listTimeoutMs' | 'writeTimeoutMs'> {
  readyTimeoutMs?: number;
  startWaitMs?: number;
  recheckDelayMs?: number;
}

/** Says only that a foreign entry exists — never its command / URL / headers (they may hold secrets). */
export const FOREIGN_ENTRY_NOTICE =
  'AI Terminal: Antigravity already has another MCP server named "obsidian", so agy cannot use the bridge. ' +
  'Run `agy mcp remove obsidian` and reload the plugin.';

/**
 * T8 — Antigravity bridge (D28): installs `mcp_shim.py` to its stable path, keeps the global agy entry
 * `obsidian` → `<python3> -I <shim>` (under the lock file; idempotent), removes it when `agyBridgeEnabled` is turned off,
 * and gives agy panels `OBSIDIAN_BRIDGE_URL` / `OBSIDIAN_BRIDGE_TOKEN`. Service: `agyBridge`.
 */
export function createAgyModule(options: AgyModuleOptions = {}): FeatureModule {
  let service: AgyBridgeService | undefined;
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    id: 'agy',
    label: 'the Antigravity bridge',
    register(ctx) {
      const log = ctx.log.child('agy');
      const shimPath = ctx.supportScripts.register(SHIM_SCRIPT);
      const config = new AgyConfig({
        getCommand: () => profileCommand(ctx.settings, 'agy').command,
        getEnv: () => agyEnv(ctx),
        run: options.run,
        lockStaleMs: options.lockStaleMs,
        lockWaitMs: options.lockWaitMs,
        listTimeoutMs: options.listTimeoutMs,
        writeTimeoutMs: options.writeTimeoutMs,
        log,
      });
      ctx.onUnload(() => {
        if (recheckTimer) clearTimeout(recheckTimer);
        config.dispose();
      });

      ctx.spawn.add(
        'agy:bridge-env',
        createAgyEnvContributor({
          getServer: () => (ctx.settings.bridgeEnabled ? ctx.services.get('bridgeServer') : undefined),
          enabled: () => ctx.settings.agyBridgeEnabled,
          startWaitMs: options.startWaitMs,
        }),
      );

      let lastOutcome: EnsureOutcome | RemoveOutcome | undefined;
      const record = <T extends EnsureOutcome | RemoveOutcome>(action: string, outcome: T): T => {
        lastOutcome = outcome;
        logOutcome(log, action, outcome);
        return outcome;
      };
      const ensure = async (): Promise<EnsureOutcome> => {
        const prepared = await prepare(ctx, shimPath);
        if ('reason' in prepared) return record('ensure', { status: 'skipped', reason: prepared.reason });
        // Turned off while preparing: the remove is already queued; adding now would undo it.
        if (!ctx.settings.agyBridgeEnabled) return record('ensure', { status: 'skipped', reason: 'agy bridge turned off' });
        return record('ensure', await config.ensureEntry(prepared.python, shimPath));
      };
      const remove = async (): Promise<RemoveOutcome> => record('remove', await config.removeEntry());

      service = {
        shimPath,
        get lastOutcome() {
          return lastOutcome;
        },
        ensure: async () => {
          const outcome = await ensure();
          if (outcome.status === 'foreign') notice(FOREIGN_ENTRY_NOTICE, 15_000);
          return outcome;
        },
        remove,
      };
      ctx.services.provide('agyBridge', service);

      ctx.onSettingsChange((s, prev) => {
        if (ctx.unloading || !service) return;
        if (s.agyBridgeEnabled !== prev.agyBridgeEnabled) {
          if (recheckTimer) clearTimeout(recheckTimer);
          if (s.agyBridgeEnabled) void service.ensure().then(noticeAfterToggleOn);
          else void remove().then(noticeAfterToggleOff);
          return;
        }
        const changed = s.pythonPath !== prev.pythonPath || s.profiles.agy.command !== prev.profiles.agy.command;
        if (s.agyBridgeEnabled && changed) {
          if (recheckTimer) clearTimeout(recheckTimer);
          recheckTimer = setTimeout(() => {
            recheckTimer = undefined;
            if (!ctx.unloading && ctx.settings.agyBridgeEnabled) void service?.ensure();
          }, options.recheckDelayMs ?? RECHECK_DELAY_MS);
        }
      });
    },

    async ready(ctx) {
      if (!ctx.settings.agyBridgeEnabled || !service) return;
      const limit = options.readyTimeoutMs ?? AGY_READY_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), limit);
      });
      const result = await Promise.race([service.ensure(), timedOut]);
      clearTimeout(timer);
      if (result === 'timeout') ctx.log.child('agy').warn(`agy entry check still running after ${limit} ms; continuing in the background`);
    },

    unload() {
      if (recheckTimer) clearTimeout(recheckTimer);
      recheckTimer = undefined;
      service = undefined;
    },
  };
}

/** Waits (bounded by the callers) for the shell PATH, the installed shim and Python. */
async function prepare(ctx: PluginContext, shimPath: string): Promise<{ python: string } | { reason: string }> {
  await ctx.services.get('shellEnv')?.whenReady();
  await ctx.supportScripts.whenInstalled();
  if (!fs.existsSync(shimPath)) return { reason: `${SHIM_SCRIPT} is not installed at ${shimPath}` };
  const python = ctx.services.get('python');
  if (!python) return { reason: 'python service unavailable' };
  try {
    return { python: await python.resolve() };
  } catch (err) {
    return { reason: (err as Error).message };
  }
}

/** The D6 spawn environment (login-shell PATH) for running `agy mcp …`. */
function agyEnv(ctx: PluginContext): Record<string, string> {
  const shellEnv = ctx.services.get('shellEnv');
  if (shellEnv) return shellEnv.getSpawnEnv();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  return env;
}

function logOutcome(log: Logger, action: string, outcome: EnsureOutcome | RemoveOutcome): void {
  switch (outcome.status) {
    case 'added':
    case 'updated':
    case 'removed':
      log.info(`agy entry "obsidian" ${outcome.status}`);
      break;
    case 'unchanged':
    case 'absent':
      log.debug(`agy entry "obsidian" ${outcome.status}`);
      break;
    case 'foreign':
      log.warn(`agy ${action}: an "obsidian" entry not created by this plugin exists; left unchanged`);
      break;
    case 'skipped':
      if (outcome.reason === AGY_NOT_FOUND) log.info(`agy ${action} skipped: ${outcome.reason}`);
      else log.warn(`agy ${action} skipped: ${outcome.reason}`);
      break;
    case 'failed':
      log.warn(`agy ${action} failed: ${outcome.reason}`);
      break;
  }
}

function noticeAfterToggleOn(outcome: EnsureOutcome): void {
  if (outcome.status === 'skipped' && outcome.reason === AGY_NOT_FOUND) {
    notice('AI Terminal: the Antigravity CLI (agy) was not found — check its command in Settings › Profiles.');
  } else if (outcome.status === 'failed') {
    notice('AI Terminal: could not add the "obsidian" MCP server to Antigravity — see the developer console.');
  }
}

function noticeAfterToggleOff(outcome: RemoveOutcome): void {
  if (outcome.status === 'failed') {
    notice('AI Terminal: could not remove the "obsidian" MCP server from Antigravity — run `agy mcp remove obsidian` in a terminal.');
  }
}
