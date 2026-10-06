import type { App } from 'obsidian';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import AiTerminalPlugin, { resolvePluginDir } from '../src/main';
import { createManifest, createMockApp, Notice, type PluginManifest } from './mocks/obsidian';

function newPlugin(vaultPath = mkdtempSync(join(tmpdir(), 'vault-')), manifest: PluginManifest = createManifest()) {
  const app = createMockApp(vaultPath);
  const plugin = new AiTerminalPlugin(app as unknown as App, manifest);
  return { app, plugin, vaultPath };
}

describe('AiTerminalPlugin', () => {
  it('loads settings, wires every feature module, reaches ready and unloads', async () => {
    const { plugin, vaultPath } = newPlugin();
    (plugin as unknown as { data: unknown }).data = { fontSize: 18 };
    await plugin.onload();
    const ctx = plugin.context;
    expect(ctx).not.toBeNull();
    expect(ctx!.settings.fontSize).toBe(18);
    expect(ctx!.settings.placement).toBe('right-sidebar');
    expect(plugin.settings).toBe(ctx!.settings);
    expect(ctx!.vaultPath).toBe(vaultPath);
    expect(ctx!.pluginDir).toBe(join(vaultPath, '.obsidian', 'plugins', 'obsidian-ai-terminal'));
    expect((plugin as unknown as { settingTabs: unknown[] }).settingTabs).toHaveLength(1);
    await ctx!.ready;
    expect(ctx!.isReady()).toBe(true);
    plugin.onunload();
    expect(ctx!.unloading).toBe(true);
    expect(plugin.context).toBeNull();
  });

  it('every feature module stub registers without errors', async () => {
    Notice.clear();
    const { plugin } = newPlugin();
    await plugin.onload();
    await plugin.context!.ready;
    expect(Notice.shown.map((n) => n.message)).toEqual([]);
    plugin.onunload();
  });

  it('refuses to load without a file-system vault', async () => {
    Notice.clear();
    const { app, plugin } = newPlugin();
    (app.vault as unknown as { adapter: object }).adapter = {};
    await plugin.onload();
    expect(plugin.context).toBeNull();
    expect(Notice.shown[0]?.message).toMatch(/desktop app/);
  });

  it('resolvePluginDir prefers manifest.dir', () => {
    expect(resolvePluginDir('/v', '.obsidian', { ...createManifest(), dir: '.obsidian/plugins/custom' } as never)).toBe('/v/.obsidian/plugins/custom');
    expect(resolvePluginDir('/v', '.cfg', createManifest() as never)).toBe('/v/.cfg/plugins/obsidian-ai-terminal');
  });
});
