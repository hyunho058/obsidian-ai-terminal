// Runtime harness for the agy module: a PluginRuntime over the bridge test app, a plugin folder holding the real
// mcp_shim.py, and a stub `python` service (no interpreter probing).
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Plugin } from 'obsidian';
import { PluginRuntime } from '../../src/core/runtime';
import type { FeatureModule } from '../../src/core/types';
import { SettingsStore } from '../../src/settings';
import { createLogger } from '../../src/util/log';
import { createBridgeEnv, silentSink, type BridgeEnv } from '../bridge/helpers';
import { Plugin as MockPlugin, createManifest } from '../mocks/obsidian';

export const SHIM_SOURCE = resolve(__dirname, '../../src/bridge/mcp_shim.py');

class TestPlugin extends MockPlugin {}

export function stubPythonModule(python = '/usr/bin/python3', delayMs = 0): FeatureModule {
  const resolve = async (): Promise<string> => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return python;
  };
  return {
    id: 'python-stub',
    register(ctx) {
      ctx.services.provide('python', { resolve, current: () => python, invalidate() {} });
    },
  };
}

export async function startAgyRuntime(modules: FeatureModule[], data: unknown = null, env: BridgeEnv = createBridgeEnv(), awaitReady = true) {
  const pluginDir = mkdtempSync(join(tmpdir(), 'plugindir-'));
  copyFileSync(SHIM_SOURCE, join(pluginDir, 'mcp_shim.py'));
  const plugin = new TestPlugin(env.app, createManifest());
  const store = new SettingsStore((d) => plugin.saveData(d));
  store.load(data);
  const out = silentSink();
  const runtime = new PluginRuntime({
    app: env.obsidianApp,
    plugin: plugin as unknown as Plugin,
    settingsStore: store,
    vaultPath: '/vault',
    pluginDir,
    log: createLogger(undefined, out),
  });
  await runtime.start(modules);
  if (awaitReady) await runtime.ctx.ready;
  return { runtime, ctx: runtime.ctx, store, out, env, pluginDir };
}

/** Polls `check` until it returns true (or fails after `timeoutMs`). */
export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}
