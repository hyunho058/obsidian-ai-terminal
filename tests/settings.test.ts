import type { App, Plugin } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AiTerminalSettingTab,
  defaultSettings,
  mergeSettings,
  parseArgs,
  profileCommand,
  SettingsStore,
  type AiTerminalSettings,
} from '../src/settings';
import {
  createManifest,
  createMockApp,
  DropdownComponent,
  Plugin as MockPlugin,
  Setting,
  SliderComponent,
  TextComponent,
  ToggleComponent,
} from './mocks/obsidian';

class TestPlugin extends MockPlugin {}

describe('defaults (R14.2)', () => {
  it('match the spec', () => {
    const d = defaultSettings();
    expect(d.placement).toBe('right-sidebar');
    expect(d.scrollback).toBe(10000);
    expect(d.optionIsMeta).toBe(true);
    expect(d.bridgeEnabled).toBe(true);
    expect(d.ideConnectionEnabled).toBe(true);
    expect(d.agyBridgeEnabled).toBe(true);
    expect(d.snapshots.enabled).toBeNull();
    expect(d.fontSize).toBe(13);
    expect(d.pythonPath).toBe('');
    expect(d.profiles.claude).toEqual({ command: 'claude', args: '' });
    expect(d.profiles.agy).toEqual({ command: 'agy', args: '' });
    expect(d.profiles.shell).toEqual({ command: process.env.SHELL || '/bin/zsh', args: '-l' });
    expect(d.moduleData).toEqual({});
  });

  it('are a fresh object every time', () => {
    const a = defaultSettings();
    a.profiles.claude.command = 'x';
    expect(defaultSettings().profiles.claude.command).toBe('claude');
  });

  it('mergeSettings(null / garbage) gives defaults', () => {
    expect(mergeSettings(null)).toEqual(defaultSettings());
    expect(mergeSettings('nope')).toEqual(defaultSettings());
    expect(mergeSettings([1, 2])).toEqual(defaultSettings());
  });
});

describe('mergeSettings', () => {
  it('deep-merges partial stored data over defaults', () => {
    const s = mergeSettings({ profiles: { claude: { args: '--model sonnet' } }, fontSize: 15, snapshots: { enabled: true } });
    expect(s.profiles.claude).toEqual({ command: 'claude', args: '--model sonnet' });
    expect(s.profiles.agy.command).toBe('agy');
    expect(s.fontSize).toBe(15);
    expect(s.snapshots.enabled).toBe(true);
    expect(s.scrollback).toBe(10000);
  });

  it('drops values of the wrong type and out-of-range values', () => {
    const s = mergeSettings({
      placement: 'floating',
      fontSize: '14',
      scrollback: -5,
      optionIsMeta: 'yes',
      profiles: { shell: 'zsh' },
      snapshots: { enabled: 'maybe' },
    });
    const d = defaultSettings();
    expect(s.placement).toBe(d.placement);
    expect(s.fontSize).toBe(d.fontSize);
    expect(s.scrollback).toBe(d.scrollback);
    expect(s.optionIsMeta).toBe(true);
    expect(s.profiles.shell).toEqual(d.profiles.shell);
    expect(s.snapshots.enabled).toBeNull();
  });

  it('keeps snapshots.enabled = false and preserves unknown keys and moduleData', () => {
    const s = mergeSettings({ snapshots: { enabled: false }, futureKey: 1, moduleData: { agy: { port: 1234 } } });
    expect(s.snapshots.enabled).toBe(false);
    expect((s as unknown as Record<string, unknown>).futureKey).toBe(1);
    expect(s.moduleData).toEqual({ agy: { port: 1234 } });
  });

  it('ignores prototype-polluting keys', () => {
    const s = mergeSettings(JSON.parse('{"__proto__": {"polluted": true}, "profiles": {"__proto__": {"x": 1}}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(s.profiles.claude.command).toBe('claude');
  });
});

describe('parseArgs / profileCommand', () => {
  it.each([
    ['', []],
    ['--model sonnet', ['--model', 'sonnet']],
    ['  -a   -b  ', ['-a', '-b']],
    [`--name "two words" 'single quoted'`, ['--name', 'two words', 'single quoted']],
    [`--json '{"a": 1}'`, ['--json', '{"a": 1}']],
    [`a\\ b "c\\"d" ''`, ['a b', 'c"d', '']],
  ])('parseArgs(%j)', (input, expected) => {
    expect(parseArgs(input)).toEqual(expected);
  });

  it('profileCommand splits args and falls back to the default command', () => {
    const s = defaultSettings();
    s.profiles.claude.args = '--model sonnet';
    expect(profileCommand(s, 'claude')).toEqual({ command: 'claude', args: ['--model', 'sonnet'] });
    s.profiles.agy.command = '  ';
    expect(profileCommand(s, 'agy').command).toBe('agy');
    expect(profileCommand(s, 'shell').args).toEqual(['-l']);
  });
});

describe('SettingsStore', () => {
  it('keeps one live object across load and notifies with the previous values', async () => {
    const saved: AiTerminalSettings[] = [];
    const store = new SettingsStore(async (d) => void saved.push(structuredClone(d)));
    const live = store.settings;
    store.load({ fontSize: 20 });
    expect(store.settings).toBe(live);
    expect(live.fontSize).toBe(20);
    const seen: Array<[number, number]> = [];
    const off = store.onChange((s, prev) => seen.push([prev.fontSize, s.fontSize]));
    live.fontSize = 21;
    await store.save();
    live.fontSize = 22;
    await store.save();
    off();
    live.fontSize = 23;
    await store.save();
    expect(seen).toEqual([
      [20, 21],
      [21, 22],
    ]);
    expect(saved.map((s) => s.fontSize)).toEqual([21, 22, 23]);
  });

  it('a throwing listener does not break save', async () => {
    const errors: unknown[] = [];
    const store = new SettingsStore(async () => {}, (e) => errors.push(e));
    store.onChange(() => {
      throw new Error('x');
    });
    await expect(store.save()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe('AiTerminalSettingTab (R14.1, R14.2)', () => {
  beforeEach(() => Setting.reset());

  function render() {
    const app = createMockApp();
    const plugin = new TestPlugin(app, createManifest());
    const store = new SettingsStore((d) => plugin.saveData(d));
    store.load(null);
    const tab = new AiTerminalSettingTab(app as unknown as App, plugin as unknown as Plugin, store);
    tab.display();
    const byName = (name: string) => {
      const s = Setting.created.find((x) => x.name === name);
      if (!s) throw new Error(`no setting "${name}"`);
      return s.components[0];
    };
    return { plugin, store, byName };
  }

  it('shows every field with the defaults', () => {
    const { byName } = render();
    const names = Setting.created.filter((s) => !s.heading).map((s) => s.name);
    expect(names).toEqual([
      'Placement',
      'Claude Code command',
      'Claude Code arguments',
      'Antigravity command',
      'Antigravity arguments',
      'Shell command',
      'Shell arguments',
      'Python path',
      'Font family',
      'Font size',
      'Terminal colors',
      'Scrollback',
      'Option key as meta key',
      'Bridge tools',
      'Claude IDE connection',
      'Antigravity bridge',
      'AI session snapshots',
    ]);
    expect((byName('Placement') as DropdownComponent).getValue()).toBe('right-sidebar');
    expect(Object.keys((byName('Placement') as DropdownComponent).options)).toEqual(['right-sidebar', 'new-tab', 'split-below']);
    expect((byName('Scrollback') as TextComponent).getValue()).toBe('10000');
    expect((byName('Option key as meta key') as ToggleComponent).getValue()).toBe(true);
    expect((byName('Bridge tools') as ToggleComponent).getValue()).toBe(true);
    expect((byName('Claude IDE connection') as ToggleComponent).getValue()).toBe(true);
    expect((byName('Antigravity bridge') as ToggleComponent).getValue()).toBe(true);
    expect((byName('AI session snapshots') as DropdownComponent).getValue()).toBe('ask');
    expect((byName('Terminal colors') as DropdownComponent).getValue()).toBe('obsidian');
    expect(Object.keys((byName('Terminal colors') as DropdownComponent).options)).toEqual(['obsidian', 'dark', 'light']);
  });

  it('Terminal colors: choosing Dark is saved; an unknown stored value falls back to following Obsidian', async () => {
    const { store, byName } = render();
    await (byName('Terminal colors') as DropdownComponent).simulateChange('dark');
    expect(store.settings.terminalColors).toBe('dark');
    expect(mergeSettings({ terminalColors: 'purple' }).terminalColors).toBe('obsidian');
    expect(mergeSettings({ terminalColors: 'light' }).terminalColors).toBe('light');
  });

  it('the Bridge tools toggle is described in plain words (no MCP / token jargon)', () => {
    render();
    const bridge = Setting.created.find((s) => s.name === 'Bridge tools')!;
    expect(bridge.desc).toBe('Let the AI read your open note, selection and links, and open notes. Snapshots keep working when this is off.');
    expect(bridge.desc).not.toMatch(/MCP|token|server/i);
  });

  it('edits persist and survive a reload', async () => {
    const { plugin, store, byName } = render();
    await (byName('Placement') as DropdownComponent).simulateChange('new-tab');
    await (byName('Claude Code arguments') as TextComponent).simulateChange('--model sonnet');
    await (byName('Font size') as SliderComponent).simulateChange(16);
    await (byName('Option key as meta key') as ToggleComponent).simulateChange(false);
    await (byName('Scrollback') as TextComponent).simulateChange('abc'); // ignored
    await (byName('AI session snapshots') as DropdownComponent).simulateChange('off');
    await new Promise((r) => setTimeout(r, 0));

    const reloaded = new SettingsStore(async () => {});
    reloaded.load(await plugin.loadData());
    expect(reloaded.settings.placement).toBe('new-tab');
    expect(profileCommand(reloaded.settings, 'claude').args).toEqual(['--model', 'sonnet']);
    expect(reloaded.settings.fontSize).toBe(16);
    expect(reloaded.settings.optionIsMeta).toBe(false);
    expect(reloaded.settings.scrollback).toBe(10000);
    expect(reloaded.settings.snapshots.enabled).toBe(false);
    expect(store.settings.snapshots.enabled).toBe(false);
  });
});
