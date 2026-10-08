import type { App, TAbstractFile } from 'obsidian';
import type { FeatureModule, PluginContext } from '../core';
import { notice } from '../util/log';
import { createAgyEnterInterceptor } from './agyEnterHold';
import { createClaudeHookContributor, SNAPSHOT_HOOK_SCRIPT } from './claudeHookContributor';
import { createSnapshotRoute, SNAPSHOT_ROUTE } from './endpoint';
import { FirstUsePrompt, openEnableSnapshotsModal, type OpenFirstUseModal } from './firstUse';
import { checkGit, GitRunner, SYSTEM_GIT, type GitAvailability } from './git';
import { SnapshotService } from './service';
import { createSpawnSnapshotHook } from './spawnSnapshot';
import { SnapshotStore } from './store';

export { AGY_WAIT_MS, createAgyEnterInterceptor } from './agyEnterHold';
export { claudeHookSettings, createClaudeHookContributor, PANEL_ID_ENV, SNAPSHOT_HOOK_SCRIPT } from './claudeHookContributor';
export { createSnapshotRoute, HOOK_WAIT_MS, SNAPSHOT_ROUTE } from './endpoint';
export { EnableSnapshotsModal, FIRST_USE_QUESTION, FirstUsePrompt, type FirstUseAnswer } from './firstUse';
export { SnapshotService } from './service';
export { SPAWN_WAIT_MS } from './spawnSnapshot';
export { SnapshotError, SnapshotStore, snapshotPathspecs, storePathFor } from './store';
export type * from './types';

/** Note types whose changes set the change flag. */
const NOTE_EXTENSIONS = new Set(['md', 'canvas', 'base']);

export interface SnapshotModuleOptions {
  /** git binary (tests use a wrapper); default `/usr/bin/git`. */
  gitPath?: string;
  /** Replaces the R12.16 probe (tests). */
  checkGit?: () => Promise<GitAvailability>;
  /** Store location (tests); default `storePathFor(vaultPath)`. */
  storePath?: string;
  hookWaitMs?: number;
  spawnWaitMs?: number;
  agyWaitMs?: number;
  firstUseTimeoutMs?: number;
  /** Replaces the first-use modal (tests). */
  openFirstUse?: (app: App) => OpenFirstUseModal;
  now?: () => Date;
}

/** True if a vault event may change what a snapshot contains (a note, or a folder that may hold notes). */
export function affectsSnapshots(file: TAbstractFile, oldPath?: string): boolean {
  const ext = (file as { extension?: unknown }).extension;
  if (typeof ext !== 'string') return true;
  return NOTE_EXTENSIONS.has(ext.toLowerCase()) || (oldPath !== undefined && NOTE_EXTENSIONS.has(extensionOf(oldPath)));
}

function extensionOf(p: string): string {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function nestedRepositoriesMessage(dirs: readonly string[]): string {
  const shown = dirs.slice(0, 5).join(', ');
  const more = dirs.length > 5 ? ` and ${dirs.length - 5} more` : '';
  return `AI Terminal: ${dirs.length === 1 ? 'this folder is a separate git repository' : 'these folders are separate git repositories'}, so AI session snapshots can't include ${dirs.length === 1 ? 'its' : 'their'} notes: ${shown}${more}`;
}

/**
 * T9 — snapshots before every AI message (D31, D32): the `snapshots` service, change flag from vault events, first-use
 * question + spawn-time snapshot (`beforeSpawn`), `POST /snapshot` for `snapshot_hook.py`, the Claude `--settings`
 * contributor and the agy Enter interceptor.
 */
export function createSnapshotModule(options: SnapshotModuleOptions = {}): FeatureModule {
  let service: SnapshotService | null = null;
  let firstUse: FirstUsePrompt | null = null;
  let unavailableNoticeShown = false;

  const notifyUnavailable = (reason: string): void => {
    if (unavailableNoticeShown) return;
    unavailableNoticeShown = true;
    notice(`AI Terminal: AI session snapshots are off — git is not available: ${reason}.`, 15_000);
  };

  const startFirstSnapshot = (ctx: PluginContext, svc: SnapshotService): void => {
    void svc.checkAvailability().then(async (a) => {
      if (!a.ok) {
        notifyUnavailable(a.reason);
        return;
      }
      const r = await svc.snapshotNow({ kind: 'first' });
      if (r.status === 'failed' && !ctx.unloading) notice(`AI Terminal: the first snapshot of this vault failed: ${r.reason ?? 'unknown error'}.`, 15_000);
    });
  };

  return {
    id: 'snapshot',
    label: 'snapshots',
    register(ctx) {
      const log = ctx.log.child('snapshot');
      const hookPath = ctx.supportScripts.register(SNAPSHOT_HOOK_SCRIPT);
      const git = new GitRunner(options.gitPath ?? SYSTEM_GIT);
      const store = new SnapshotStore({ vaultPath: ctx.vaultPath, git, storePath: options.storePath, configDir: ctx.app.vault.configDir, log });
      const svc = new SnapshotService({
        store,
        isTurnedOn: () => ctx.settings.snapshots.enabled === true,
        checkGit: options.checkGit ?? (() => checkGit(git.gitPath)),
        log,
        onNestedRepositories: (dirs) => notice(nestedRepositoriesMessage(dirs), 15_000),
        now: options.now,
      });
      service = svc;
      // R12.6: anything may have changed while Obsidian was closed.
      svc.markChanged('plugin load');
      ctx.services.provide('snapshots', svc);

      const vault = ctx.app.vault;
      const onChange = (file: TAbstractFile, oldPath?: string): void => {
        if (affectsSnapshots(file, oldPath)) svc.markChanged('vault change');
      };
      ctx.plugin.registerEvent(vault.on('modify', (f) => onChange(f)));
      ctx.plugin.registerEvent(vault.on('create', (f) => onChange(f)));
      ctx.plugin.registerEvent(vault.on('delete', (f) => onChange(f)));
      ctx.plugin.registerEvent(vault.on('rename', (f, oldPath) => onChange(f, oldPath)));

      ctx.onSettingsChange((s, prev) => {
        if (ctx.unloading || s.snapshots.enabled !== true || prev.snapshots.enabled === true) return;
        svc.markChanged('snapshots turned on');
        startFirstSnapshot(ctx, svc);
      });

      const prompt = new FirstUsePrompt({
        open: (options.openFirstUse ?? openEnableSnapshotsModal)(ctx.app),
        apply: async (answer) => {
          if (answer === 'dismiss' || ctx.unloading || ctx.settings.snapshots.enabled !== null) return;
          ctx.settings.snapshots.enabled = answer === 'enable';
          await ctx.saveSettings();
        },
        timeoutMs: options.firstUseTimeoutMs,
      });
      firstUse = prompt;

      ctx.sessionEvents.beforeSpawn(
        createSpawnSnapshotHook({
          service: svc,
          enabledSetting: () => ctx.settings.snapshots.enabled,
          firstUse: prompt,
          onUnavailable: notifyUnavailable,
          waitMs: options.spawnWaitMs,
        }),
      );
      // The hook posts to the bridge server's `/snapshot`, so keep that server up while snapshots are on or "not asked
      // yet" (deviation 8) — also with the bridge tools off (deviation 19). Missing git: the endpoint answers "disabled".
      const bridge = ctx.services.get('bridgeServer');
      if (bridge) ctx.onUnload(bridge.keepRunningWhile('snapshots', () => ctx.settings.snapshots.enabled !== false));
      ctx.spawn.add(
        'snapshot:claude-hook',
        createClaudeHookContributor({
          wantsHook: () => svc.isAvailable() && ctx.settings.snapshots.enabled !== false,
          getServer: () => ctx.services.get('bridgeServer'),
          resolvePython: () => {
            const python = ctx.services.get('python');
            return python ? python.resolve() : Promise.reject(new Error('the python service is not available'));
          },
          hookPath,
          log,
        }),
      );
      ctx.keyboard.onEnterIntercept(createAgyEnterInterceptor(svc, options.agyWaitMs));
      ctx.routes.addRoute(
        'POST',
        SNAPSHOT_ROUTE,
        createSnapshotRoute({ service: svc, getPanel: (id) => ctx.services.get('sessions')?.get(id), waitMs: options.hookWaitMs, log }),
      );
    },
    async ready(ctx) {
      const a = await service?.checkAvailability();
      if (a && !a.ok && ctx.settings.snapshots.enabled === true) notifyUnavailable(a.reason);
    },
    unload() {
      firstUse?.dispose();
      service?.dispose();
      firstUse = null;
      service = null;
    },
  };
}
