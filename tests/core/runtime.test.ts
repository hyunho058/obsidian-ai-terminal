import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App, Plugin } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFailureNotice, PluginRuntime } from '../../src/core/runtime';
import type { FeatureModule, PluginContext } from '../../src/core/types';
import { SettingsStore } from '../../src/settings';
import { supportScriptPath } from '../../src/support/installScripts';
import { createLogger, type LogSink } from '../../src/util/log';
import { createManifest, createMockApp, Notice, Plugin as MockPlugin } from '../mocks/obsidian';

class TestPlugin extends MockPlugin {}

function sink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]) => lines.push(a.join(' '));
  return { lines, debug: push, info: push, warn: push, error: push };
}

function makeRuntime(opts: { pluginDir?: string; readyTimeoutMs?: number } = {}) {
  const app = createMockApp('/vault');
  const plugin = new TestPlugin(app, createManifest());
  const store = new SettingsStore((d) => plugin.saveData(d));
  store.load(null);
  const out = sink();
  const runtime = new PluginRuntime({
    app: app as unknown as App,
    plugin: plugin as unknown as Plugin,
    settingsStore: store,
    vaultPath: '/vault',
    pluginDir: opts.pluginDir ?? mkdtempSync(join(tmpdir(), 'plugindir-')),
    log: createLogger(undefined, out),
    readyTimeoutMs: opts.readyTimeoutMs,
  });
  return { runtime, plugin, store, out };
}

beforeEach(() => Notice.clear());

describe('PluginRuntime', () => {
  it('registers modules in order, then resolves ready after every ready() settles', async () => {
    const { runtime } = makeRuntime();
    const order: string[] = [];
    let release!: () => void;
    const mods: FeatureModule[] = [
      { id: 'a', register: () => void order.push('reg:a'), ready: async () => void order.push('ready:a') },
      {
        id: 'b',
        register: async () => void order.push('reg:b'),
        ready: () => new Promise<void>((r) => (release = () => (order.push('ready:b'), r()))),
      },
    ];
    await runtime.start(mods);
    expect(order).toEqual(['reg:a', 'reg:b', 'ready:a']);
    expect(runtime.ctx.isReady()).toBe(false);
    release();
    await runtime.ctx.ready;
    expect(runtime.ctx.isReady()).toBe(true);
    expect(order).toEqual(['reg:a', 'reg:b', 'ready:a', 'ready:b']);
  });

  it('a failing register() or ready() does not block the others', async () => {
    const { runtime, out } = makeRuntime();
    const ready = vi.fn(async () => {});
    await runtime.start([
      { id: 'broken', register: () => {
        throw new Error('nope');
      }, ready },
      { id: 'flaky', register: () => {}, ready: async () => {
        throw new Error('later');
      } },
      { id: 'ok', register: () => {}, ready },
    ]);
    await runtime.ctx.ready;
    expect(ready).toHaveBeenCalledTimes(1); // only "ok": broken never registered
    expect(out.lines.join('\n')).toMatch(/"broken" failed to register/);
    expect(out.lines.join('\n')).toMatch(/"flaky" ready failed/);
    // The Notice never shows the internal module id.
    expect(Notice.shown.map((n) => n.message)).toEqual(['AI Terminal: a part of AI Terminal failed to load. Reload the plugin; details are in the developer console.']);
  });

  it('a failing module with a plain label is named by that label in the Notice, never by its id', async () => {
    const { runtime } = makeRuntime();
    await runtime.start([
      { id: 'close-flow', label: 'close confirmation', register: () => {
        throw new Error('nope');
      } },
    ]);
    await runtime.ctx.ready;
    expect(Notice.shown.map((n) => n.message)).toEqual(['AI Terminal: close confirmation failed to load. Reload the plugin; details are in the developer console.']);
    expect(Notice.shown[0]!.message).not.toContain('close-flow');
  });

  it('every real feature module has a plain label', async () => {
    const factories = [
      (await import('../../src/env/index')).createEnvModule,
      (await import('../../src/pty/index')).createPtyModule,
      (await import('../../src/session/index')).createSessionModule,
      (await import('../../src/terminal/index')).createTerminalModule,
      (await import('../../src/terminal/keyboardModule')).createKeyboardModule,
      (await import('../../src/terminal/closeFlowModule')).createCloseFlowModule,
      (await import('../../src/session/resumeModule')).createResumeModule,
      (await import('../../src/bridge/index')).createBridgeModule,
      (await import('../../src/bridge/ideModule')).createIdeModule,
      (await import('../../src/bridge/agyModule')).createAgyModule,
      (await import('../../src/snapshot/index')).createSnapshotModule,
      (await import('../../src/snapshot/restoreModule')).createRestoreModule,
    ] as Array<() => FeatureModule>;
    expect(new Set(factories.map((f) => f().id)).size).toBe(12);
    for (const create of factories) {
      const mod = create();
      expect(mod.label, mod.id).toMatch(/^[a-z][a-z ]+[a-z]$/i);
      expect(mod.label).not.toContain('-');
      expect(loadFailureNotice(mod)).toContain(mod.label!);
    }
  });

  it('the ready gate resolves after the timeout when a module hangs', async () => {
    const { runtime, out } = makeRuntime({ readyTimeoutMs: 30 });
    await runtime.start([{ id: 'hang', register: () => {}, ready: () => new Promise(() => {}) }]);
    await runtime.ctx.ready;
    expect(out.lines.join('\n')).toMatch(/timed out.*hang/);
  });

  it('installs registered support scripts as part of the ready gate', async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), 'plugindir-'));
    writeFileSync(join(pluginDir, 'mcp_shim.py'), 'print("shim")\n');
    const { runtime } = makeRuntime({ pluginDir });
    await runtime.start([{ id: 'agy', register: (ctx) => void ctx.supportScripts.register('mcp_shim.py') }]);
    await runtime.ctx.ready;
    expect(readFileSync(supportScriptPath('mcp_shim.py'), 'utf8')).toBe('print("shim")\n');
  });

  it('unload: onUnload callbacks newest-first, then modules in reverse; sets unloading', async () => {
    const { runtime } = makeRuntime();
    const order: string[] = [];
    let ctx!: PluginContext;
    const mod = (id: string): FeatureModule => ({
      id,
      register: (c) => {
        ctx = c;
        c.onUnload(() => void order.push(`cb:${id}`));
      },
      unload: (c) => void order.push(`unload:${id}:${c.unloading}`),
    });
    await runtime.start([mod('a'), mod('b')]);
    expect(ctx.unloading).toBe(false);
    runtime.unload();
    expect(order).toEqual(['cb:b', 'cb:a', 'unload:b:true', 'unload:a:true']);
    expect(ctx.unloading).toBe(true);
  });

  it('exposes live settings, saveSettings and change notifications', async () => {
    const { runtime, plugin } = makeRuntime();
    const changes: Array<[boolean, boolean]> = [];
    await runtime.start([
      {
        id: 'agy',
        register: (c) => {
          c.onSettingsChange((s, prev) => changes.push([prev.agyBridgeEnabled, s.agyBridgeEnabled]));
        },
      },
    ]);
    runtime.ctx.settings.agyBridgeEnabled = false;
    await runtime.ctx.saveSettings();
    expect(changes).toEqual([[true, false]]);
    expect((plugin.data as { agyBridgeEnabled: boolean }).agyBridgeEnabled).toBe(false);
    runtime.unload();
    runtime.ctx.settings.agyBridgeEnabled = true;
    await runtime.ctx.saveSettings();
    expect(changes).toHaveLength(1); // listeners are dropped on unload
  });

  it('context carries the shared registries', async () => {
    const { runtime } = makeRuntime();
    const c = runtime.ctx;
    expect(c.vaultPath).toBe('/vault');
    expect(typeof c.services.provide).toBe('function');
    expect(typeof c.spawn.resolve).toBe('function');
    expect(typeof c.keyboard.dispatchKey).toBe('function');
    expect(typeof c.routes.addRoute).toBe('function');
    expect(typeof c.sessionEvents.runBeforeSpawn).toBe('function');
  });
});
