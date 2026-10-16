import * as fs from 'fs';
import type { FeatureModule, PluginContext } from '../core';
import { profileCommand } from '../settings';
import { notice, type Logger } from '../util/log';
import { AGY_NOT_FOUND, AgyConfig, SHIM_SCRIPT, type AgyConfigOptions, type EnsureOutcome, type RemoveOutcome } from './agyConfig';
import { createAgyEnvContributor } from './agyEnvContributor';
import { AGY_ALLOW_RULE, AgyPermissions, type AgyPermissionsOptions, type AllowRuleOutcome } from './agyPermissions';

/** The `agyBridge` service: the global agy `obsidian` entry (D28). */
export interface AgyBridgeService {
  /** Stable path of the installed shim (`~/.config/obsidian-ai-terminal/mcp_shim.py`). */
  readonly shimPath: string;
  /** Result of the last ensure / remove, if any finished. */
  readonly lastOutcome: EnsureOutcome | RemoveOutcome | undefined;
  /** Result of the last update of agy's allow rule `mcp(obsidian/*)` (deviation 22), if any finished. */
  readonly lastAllowRuleOutcome: AllowRuleOutcome | undefined;
  /**
   * Registers / updates the entry (`agy mcp list` → `agy mcp add` if needed); when the entry is ours, then makes sure
   * agy's settings allow its tools. Never rejects.
   */
  ensure(): Promise<EnsureOutcome>;
  /** Removes the entry if this plugin created it, then the allow rule if this plugin added it. Never rejects. */
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
  /** Overrides for the settings-file writer (tests). */
  permissions?: Pick<AgyPermissionsOptions, 'writeNewFile' | 'homeDir'>;
}

/** Says only that a foreign entry exists — never its command / URL / headers (they may hold secrets). */
export const FOREIGN_ENTRY_NOTICE =
  'AI Terminal: Antigravity already has another MCP server named "obsidian", so agy cannot use the bridge. ' +
  'Run `agy mcp remove obsidian` and reload the plugin.';

/** agy's settings could not be updated (not JSON, odd shape, read-only): agy keeps asking before each bridge tool. */
export const ALLOW_RULE_NOTICE =
  "AI Terminal: could not update Antigravity's settings, so agy will ask before using Obsidian tools. You can allow them in agy.";

/**
 * T8 — Antigravity bridge (D28): installs `mcp_shim.py` to its stable path, keeps the global agy entry
 * `obsidian` → `<python3> -I <shim>` (under the lock file; idempotent), removes it when `agyBridgeEnabled` is turned off,
 * and gives agy panels `OBSIDIAN_BRIDGE_URL` / `OBSIDIAN_BRIDGE_TOKEN`. Service: `agyBridge`.
 * Deviation 22: while the entry is ours, agy's settings allow its tools (`mcp(obsidian/*)`); the rule goes away with the
 * entry when the bridge is turned off, but only if this plugin added it (`moduleData.agy.allowRuleAdded`).
 */
export function createAgyModule(options: AgyModuleOptions = {}): FeatureModule {
  let service: AgyBridgeService | undefined;
  let recheckTimer: number | undefined;

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
      const permissions = new AgyPermissions({
        lockStaleMs: options.lockStaleMs,
        lockWaitMs: options.lockWaitMs,
        log,
        ...options.permissions,
      });
      ctx.onUnload(() => {
        if (recheckTimer) window.clearTimeout(recheckTimer);
        config.dispose();
        permissions.dispose();
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

      // Allow-rule steps run one at a time, in the order the entry operations finished (toggle off → on stays ordered).
      let ruleChain: Promise<unknown> = Promise.resolve();
      let lastAllowRuleOutcome: AllowRuleOutcome | undefined;
      let ruleNoticeShown = false;
      const ruleStep = (step: () => Promise<void>): Promise<void> => {
        const task = ruleChain.then(step).catch((err) => log.warn('agy allow rule step failed', err));
        ruleChain = task;
        return task;
      };
      const recordRule = (action: string, outcome: AllowRuleOutcome): AllowRuleOutcome => {
        lastAllowRuleOutcome = outcome;
        logRuleOutcome(log, action, outcome);
        return outcome;
      };
      const markRuleAdded = async (added: boolean): Promise<void> => {
        const { allowRuleAdded: _, ...rest } = agyData(ctx);
        ctx.settings.moduleData.agy = added ? { ...rest, allowRuleAdded: true } : rest;
        try {
          await ctx.saveSettings();
        } catch (err) {
          log.warn('could not save the agy allow-rule flag', err);
        }
      };
      const wanted = (): boolean => !ctx.unloading && ctx.settings.agyBridgeEnabled;
      const ensureRule = (): Promise<void> =>
        ruleStep(async () => {
          if (!wanted()) return;
          const outcome = recordRule('ensure', await permissions.ensureAllowRule(() => !wanted()));
          if (outcome.status === 'added') await markRuleAdded(true);
          if (outcome.status === 'skipped' && outcome.settingsProblem && !ruleNoticeShown) {
            ruleNoticeShown = true;
            notice(ALLOW_RULE_NOTICE, 15_000);
          }
        });
      const removeRule = (): Promise<void> =>
        ruleStep(async () => {
          // Only a rule this plugin added; and not if the bridge was turned on again (the queued ensure keeps it).
          if (agyData(ctx).allowRuleAdded !== true || ctx.settings.agyBridgeEnabled) return;
          const outcome = recordRule('remove', await permissions.removeAllowRule());
          if (outcome.status === 'removed' || outcome.status === 'absent') await markRuleAdded(false);
        });

      const ensure = async (): Promise<EnsureOutcome> => {
        const prepared = await prepare(ctx, shimPath);
        if ('reason' in prepared) return record('ensure', { status: 'skipped', reason: prepared.reason });
        // Turned off while preparing: the remove is already queued; adding now would undo it.
        if (!ctx.settings.agyBridgeEnabled) return record('ensure', { status: 'skipped', reason: 'agy bridge turned off' });
        const outcome = record('ensure', await config.ensureEntry(prepared.python, shimPath));
        if (outcome.status === 'added' || outcome.status === 'updated' || outcome.status === 'unchanged') await ensureRule();
        return outcome;
      };
      const remove = async (): Promise<RemoveOutcome> => {
        const outcome = record('remove', await config.removeEntry());
        await removeRule();
        return outcome;
      };

      service = {
        shimPath,
        get lastOutcome() {
          return lastOutcome;
        },
        get lastAllowRuleOutcome() {
          return lastAllowRuleOutcome;
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
          if (recheckTimer) window.clearTimeout(recheckTimer);
          if (s.agyBridgeEnabled) void service.ensure().then(noticeAfterToggleOn);
          else void remove().then(noticeAfterToggleOff);
          return;
        }
        const changed = s.pythonPath !== prev.pythonPath || s.profiles.agy.command !== prev.profiles.agy.command;
        if (s.agyBridgeEnabled && changed) {
          if (recheckTimer) window.clearTimeout(recheckTimer);
          recheckTimer = window.setTimeout(() => {
            recheckTimer = undefined;
            if (!ctx.unloading && ctx.settings.agyBridgeEnabled) void service?.ensure();
          }, options.recheckDelayMs ?? RECHECK_DELAY_MS);
        }
      });
    },

    async ready(ctx) {
      if (!ctx.settings.agyBridgeEnabled || !service) return;
      const limit = options.readyTimeoutMs ?? AGY_READY_TIMEOUT_MS;
      let timer: number | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = window.setTimeout(() => resolve('timeout'), limit);
      });
      const result = await Promise.race([service.ensure(), timedOut]);
      window.clearTimeout(timer);
      if (result === 'timeout') ctx.log.child('agy').warn(`agy entry / settings check still running after ${limit} ms; continuing in the background`);
    },

    unload() {
      if (recheckTimer) window.clearTimeout(recheckTimer);
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

function logRuleOutcome(log: Logger, action: string, outcome: AllowRuleOutcome): void {
  switch (outcome.status) {
    case 'added':
    case 'removed':
      log.info(`agy allow rule ${AGY_ALLOW_RULE} ${outcome.status}`);
      break;
    case 'present':
    case 'absent':
      log.debug(`agy allow rule ${AGY_ALLOW_RULE} ${outcome.status}`);
      break;
    case 'skipped':
      if (outcome.settingsProblem) log.warn(`agy allow rule ${action} skipped: ${outcome.reason}`);
      else log.info(`agy allow rule ${action} skipped: ${outcome.reason}`);
      break;
    case 'failed':
      log.warn(`agy allow rule ${action} failed: ${outcome.reason}`);
      break;
  }
}

/** Per-vault agy module state in `settings.moduleData.agy`. */
interface AgyModuleData {
  /** This plugin added `mcp(obsidian/*)` to agy's settings (so turning the bridge off removes it again). */
  allowRuleAdded?: boolean;
}

function agyData(ctx: PluginContext): AgyModuleData {
  const data = ctx.settings.moduleData.agy;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
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
