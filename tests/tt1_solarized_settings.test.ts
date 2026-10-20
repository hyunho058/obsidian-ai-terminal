// TT1 — acceptance tests for R1 of specs/solarized-terminal-colors/spec.md (D1, D7).
import type { App, Plugin } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { AiTerminalSettingTab, mergeSettings, SettingsStore } from '../src/settings';
import { createManifest, createMockApp, DropdownComponent, Plugin as MockPlugin, Setting } from './mocks/obsidian';

class TT1Plugin extends MockPlugin {}

function renderTab() {
  const app = createMockApp();
  const plugin = new TT1Plugin(app, createManifest());
  const saves: unknown[] = [];
  const store = new SettingsStore(async (d) => {
    saves.push(structuredClone(d));
    await plugin.saveData(d);
  });
  store.load(null);
  const tab = new AiTerminalSettingTab(app as unknown as App, plugin as unknown as Plugin, store);
  tab.display();
  const row = Setting.created.find((s) => s.name === 'Terminal colors');
  if (!row) throw new Error('no setting "Terminal colors"');
  const dropdown = row.components[0] as DropdownComponent;
  return { store, saves, dropdown };
}

describe('TT1 / R1: Settings offer and store the two Solarized choices', () => {
  beforeEach(() => Setting.reset());

  it('R1.1: dropdown lists the Solarized choices after the existing three', () => {
    const { dropdown } = renderTab();
    expect(Object.keys(dropdown.options)).toEqual(['obsidian', 'dark', 'light', 'solarized-dark', 'solarized-light']);
    expect(Object.values(dropdown.options)).toEqual([
      'Follow Obsidian theme',
      'Dark (black background)',
      'Light (white background)',
      'Solarized Dark',
      'Solarized Light',
    ]);
    expect(dropdown.getValue()).toBe('obsidian');
  });

  it('R1.2: choosing a Solarized option is saved', async () => {
    const { store, saves, dropdown } = renderTab();
    const before = saves.length;

    await dropdown.simulateChange('solarized-dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(store.settings.terminalColors).toBe('solarized-dark');
    expect(saves.length).toBe(before + 1);
    expect((saves[saves.length - 1] as { terminalColors: string }).terminalColors).toBe('solarized-dark');

    await dropdown.simulateChange('solarized-light');
    await new Promise((r) => setTimeout(r, 0));
    expect(store.settings.terminalColors).toBe('solarized-light');
    expect(saves.length).toBe(before + 2);
    expect((saves[saves.length - 1] as { terminalColors: string }).terminalColors).toBe('solarized-light');
  });

  it('R1.3: stored Solarized values load; unknown values still fall back', () => {
    expect(mergeSettings({ terminalColors: 'solarized-dark' }).terminalColors).toBe('solarized-dark');
    expect(mergeSettings({ terminalColors: 'solarized-light' }).terminalColors).toBe('solarized-light');
    expect(mergeSettings({ terminalColors: 'solarized' }).terminalColors).toBe('obsidian');
  });
});
