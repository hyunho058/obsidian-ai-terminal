import { FileSystemAdapter, Plugin, type PluginManifest } from 'obsidian';
import * as path from 'path';
import { createAgyModule } from './bridge/agyModule';
import { createIdeModule } from './bridge/ideModule';
import { createBridgeModule } from './bridge/index';
import { PluginRuntime, type FeatureModule, type PluginContext } from './core';
import { createEnvModule } from './env/index';
import { createPtyModule } from './pty/index';
import { createResumeModule } from './session/resumeModule';
import { createSessionModule } from './session/index';
import { AiTerminalSettingTab, SettingsStore, type AiTerminalSettings } from './settings';
import { createRestoreModule } from './snapshot/restoreModule';
import { createSnapshotModule } from './snapshot/index';
import { createCloseFlowModule } from './terminal/closeFlowModule';
import { createKeyboardModule } from './terminal/keyboardModule';
import { createTerminalModule } from './terminal/index';
import { createLogger, notice } from './util/log';

/**
 * Feature modules in registration order. Order matters: spawn contributors, key handlers and
 * `beforeSpawn` hooks run in this order, and `unload()` runs in reverse.
 */
const FEATURE_MODULES: ReadonlyArray<() => FeatureModule> = [
  createEnvModule, // T2
  createPtyModule, // T2
  createSessionModule, // T3
  createTerminalModule, // T3
  createKeyboardModule, // T4
  createCloseFlowModule, // T4
  createResumeModule, // T5
  createBridgeModule, // T6
  createIdeModule, // T7
  createAgyModule, // T8
  createSnapshotModule, // T9
  createRestoreModule, // T10
];

export default class AiTerminalPlugin extends Plugin {
  declare settings: AiTerminalSettings;
  private runtime: PluginRuntime | null = null;

  /** The feature context of the current load (null before load / after unload). */
  get context(): PluginContext | null {
    return this.runtime?.ctx ?? null;
  }

  async onload(): Promise<void> {
    const log = createLogger();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      notice('AI Terminal works only in the Obsidian desktop app.');
      return;
    }
    const vaultPath = adapter.getBasePath();
    const store = new SettingsStore(
      (data) => this.saveData(data),
      (err) => log.error('settings listener failed', err),
    );
    store.load(await this.loadData());
    this.settings = store.settings;

    this.runtime = new PluginRuntime({
      app: this.app,
      plugin: this,
      settingsStore: store,
      vaultPath,
      pluginDir: resolvePluginDir(vaultPath, this.app.vault.configDir, this.manifest),
      log,
    });
    this.addSettingTab(new AiTerminalSettingTab(this.app, this, store));
    await this.runtime.start(FEATURE_MODULES.map((create) => create()));
  }

  onunload(): void {
    this.runtime?.unload();
    this.runtime = null;
  }
}

/** Absolute plugin folder: `manifest.dir` is vault-relative (e.g. `.obsidian/plugins/obsidian-ai-terminal`). */
export function resolvePluginDir(vaultPath: string, configDir: string, manifest: PluginManifest): string {
  const rel = manifest.dir ?? path.join(configDir, 'plugins', manifest.id);
  return path.resolve(vaultPath, rel);
}
