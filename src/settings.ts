import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { PROFILE_IDS, PROFILE_LABELS, type ProfileId } from './core/constants';
import type { Disposer } from './core/types';

export type Placement = 'right-sidebar' | 'new-tab' | 'split-below';

export const PLACEMENT_LABELS: Readonly<Record<Placement, string>> = {
  'right-sidebar': 'Right sidebar',
  'new-tab': 'New tab',
  'split-below': 'Split below current note',
};

export interface ProfileSettings {
  /** Program to run, e.g. `claude`. Resolved on the spawn PATH. */
  command: string;
  /** Arguments as typed by the user (shell-like quoting); split with `parseArgs`. */
  args: string;
}

/** D18 settings shape, stored per vault in the plugin's `data.json`. */
export interface AiTerminalSettings {
  placement: Placement;
  profiles: Record<ProfileId, ProfileSettings>;
  /** Python 3 for the helper scripts; empty = auto (D7). */
  pythonPath: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  /** Option key acts as Meta (D10). */
  optionIsMeta: boolean;
  /** HTTP MCP bridge tools (D27b). Off: `/mcp` is refused; the server still serves snapshots (deviations 19, 20). */
  bridgeEnabled: boolean;
  /** Claude Code IDE connection (D27a). */
  ideConnectionEnabled: boolean;
  /** Antigravity `obsidian` MCP entry (D28). */
  agyBridgeEnabled: boolean;
  /** `enabled: null` = not asked yet (D31). */
  snapshots: { enabled: boolean | null };
  /**
   * Free-form persisted state for feature modules, keyed by module id (e.g. `ide.diffHintShown`, D35). Not shown in
   * the settings tab; never holds tokens. Use `ctx.settings.moduleData[id]` + `ctx.saveSettings()`.
   */
  moduleData: Record<string, unknown>;
}

export const DEFAULT_FONT_FAMILY = 'Menlo, Monaco, "SF Mono", "Courier New", monospace';

export function defaultShell(): string {
  return process.env.SHELL || '/bin/zsh';
}

/** A fresh copy of the defaults (R14.2). */
export function defaultSettings(): AiTerminalSettings {
  return {
    placement: 'right-sidebar',
    profiles: {
      claude: { command: 'claude', args: '' },
      agy: { command: 'agy', args: '' },
      shell: { command: defaultShell(), args: '-l' },
    },
    pythonPath: '',
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: 13,
    scrollback: 10000,
    optionIsMeta: true,
    bridgeEnabled: true,
    ideConnectionEnabled: true,
    agyBridgeEnabled: true,
    snapshots: { enabled: null },
    moduleData: {},
  };
}

const PLACEMENTS = Object.keys(PLACEMENT_LABELS) as Placement[];

/**
 * Deep-merges stored data over the defaults. Known keys keep the default's type (a value of another type is
 * dropped); unknown keys are preserved. Out-of-range values fall back to the default.
 */
export function mergeSettings(raw: unknown): AiTerminalSettings {
  const merged = defaultSettings();
  if (isPlainObject(raw)) deepMergeInto(merged as unknown as Record<string, unknown>, raw);
  const d = defaultSettings();
  if (!PLACEMENTS.includes(merged.placement)) merged.placement = d.placement;
  if (!Number.isFinite(merged.fontSize) || merged.fontSize < 6 || merged.fontSize > 72) merged.fontSize = d.fontSize;
  if (!Number.isInteger(merged.scrollback) || merged.scrollback < 0 || merged.scrollback > 1_000_000) merged.scrollback = d.scrollback;
  const enabled: unknown = merged.snapshots.enabled;
  if (enabled !== null && typeof enabled !== 'boolean') merged.snapshots.enabled = null;
  return merged;
}

function deepMergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = target[key];
    if (isPlainObject(current)) {
      if (isPlainObject(value)) deepMergeInto(current, value);
    } else if (!(key in target) || current === null || typeof current === typeof value) {
      target[key] = value;
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Splits an argument string like a POSIX shell (single/double quotes, backslash escapes; no expansion). */
export function parseArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1] as string)) cur += input[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

/** The command and split arguments for a profile; an empty command falls back to the default. */
export function profileCommand(settings: AiTerminalSettings, profile: ProfileId): { command: string; args: string[] } {
  const p = settings.profiles[profile];
  const command = p.command.trim() || defaultSettings().profiles[profile].command;
  return { command, args: parseArgs(p.args) };
}

export type SettingsChangeListener = (settings: AiTerminalSettings, previous: AiTerminalSettings) => void;

/** Owns the live settings object, persistence and change notifications. */
export class SettingsStore {
  /** Live object: never replaced, only mutated. */
  readonly settings: AiTerminalSettings = defaultSettings();
  private previous: AiTerminalSettings = defaultSettings();
  private readonly listeners = new Set<SettingsChangeListener>();

  constructor(
    private readonly persist: (data: AiTerminalSettings) => Promise<void>,
    private readonly onListenerError: (err: unknown) => void = (e) => console.error(e),
  ) {}

  /** Replaces the contents of the live object with `mergeSettings(raw)`. */
  load(raw: unknown): void {
    const merged = mergeSettings(raw);
    const live = this.settings as unknown as Record<string, unknown>;
    for (const key of Object.keys(live)) delete live[key];
    Object.assign(live, merged);
    this.previous = structuredClone(merged);
  }

  async save(): Promise<void> {
    await this.persist(this.settings);
    const previous = this.previous;
    this.previous = structuredClone(this.settings);
    for (const listener of [...this.listeners]) {
      try {
        listener(this.settings, previous);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }

  onChange(listener: SettingsChangeListener): Disposer {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}

type SnapshotChoice = 'ask' | 'on' | 'off';

export class AiTerminalSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly store: SettingsStore,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.store.settings;
    const save = (): void => {
      void this.store.save();
    };
    containerEl.empty();

    new Setting(containerEl).setName('Panels').setHeading();
    new Setting(containerEl)
      .setName('Placement')
      .setDesc('Where new terminal panels open.')
      .addDropdown((dd) => {
        for (const p of PLACEMENTS) dd.addOption(p, PLACEMENT_LABELS[p]);
        dd.setValue(s.placement).onChange((v) => {
          s.placement = v as Placement;
          save();
        });
      });

    new Setting(containerEl).setName('Profiles').setHeading();
    for (const id of PROFILE_IDS) {
      const label = PROFILE_LABELS[id];
      new Setting(containerEl)
        .setName(`${label} command`)
        .setDesc(id === 'shell' ? 'Shell program (started as a login shell with -l).' : `Program started by "Open ${label}".`)
        .addText((t) =>
          t
            .setPlaceholder(defaultSettings().profiles[id].command)
            .setValue(s.profiles[id].command)
            .onChange((v) => {
              s.profiles[id].command = v.trim();
              save();
            }),
        );
      new Setting(containerEl)
        .setName(`${label} arguments`)
        .setDesc('Extra arguments, e.g. --model sonnet. Quotes work like in a shell.')
        .addText((t) =>
          t.setValue(s.profiles[id].args).onChange((v) => {
            s.profiles[id].args = v;
            save();
          }),
        );
    }

    new Setting(containerEl).setName('Terminal').setHeading();
    new Setting(containerEl)
      .setName('Python path')
      .setDesc('Python 3 used by the terminal helper. Empty = python3 on your PATH, then /usr/bin/python3.')
      .addText((t) =>
        t
          .setPlaceholder('Automatic')
          .setValue(s.pythonPath)
          .onChange((v) => {
            s.pythonPath = v.trim();
            save();
          }),
      );
    new Setting(containerEl)
      .setName('Font family')
      .setDesc('CSS font-family list for terminal text.')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_FONT_FAMILY)
          .setValue(s.fontFamily)
          .onChange((v) => {
            s.fontFamily = v.trim() || DEFAULT_FONT_FAMILY;
            save();
          }),
      );
    new Setting(containerEl)
      .setName('Font size')
      .addSlider((sl) =>
        sl
          .setLimits(8, 32, 1)
          .setValue(s.fontSize)
          .setDynamicTooltip()
          .onChange((v) => {
            s.fontSize = v;
            save();
          }),
      );
    new Setting(containerEl)
      .setName('Scrollback')
      .setDesc('Lines kept above the screen (0–1000000).')
      .addText((t) =>
        t.setValue(String(s.scrollback)).onChange((v) => {
          const n = Number(v.trim());
          if (Number.isInteger(n) && n >= 0 && n <= 1_000_000) {
            s.scrollback = n;
            save();
          }
        }),
      );
    new Setting(containerEl)
      .setName('Option key acts as Meta')
      .setDesc('On: Option+key sends Meta (word movement, Claude Code shortcuts). Off: Option types special characters.')
      .addToggle((tg) =>
        tg.setValue(s.optionIsMeta).onChange((v) => {
          s.optionIsMeta = v;
          save();
        }),
      );

    new Setting(containerEl).setName('Obsidian bridge').setHeading();
    new Setting(containerEl)
      .setName('Bridge tools')
      .setDesc('Let the AI read your open note, selection and links, and open notes. Snapshots keep working when this is off.')
      .addToggle((tg) =>
        tg.setValue(s.bridgeEnabled).onChange((v) => {
          s.bridgeEnabled = v;
          save();
        }),
      );
    new Setting(containerEl)
      .setName('Claude Code IDE connection')
      .setDesc('Share the current selection with Claude Code automatically (like VS Code).')
      .addToggle((tg) =>
        tg.setValue(s.ideConnectionEnabled).onChange((v) => {
          s.ideConnectionEnabled = v;
          save();
        }),
      );
    new Setting(containerEl)
      .setName('Antigravity bridge')
      .setDesc('Register the "obsidian" MCP server with agy (agy mcp add / remove).')
      .addToggle((tg) =>
        tg.setValue(s.agyBridgeEnabled).onChange((v) => {
          s.agyBridgeEnabled = v;
          save();
        }),
      );

    new Setting(containerEl).setName('Snapshots').setHeading();
    new Setting(containerEl)
      .setName('AI session snapshots')
      .setDesc('Save a restore point of your notes before every message to an AI (stored outside the vault).')
      .addDropdown((dd) => {
        dd.addOption('ask', 'Not asked yet');
        dd.addOption('on', 'On');
        dd.addOption('off', 'Off');
        dd.setValue(toChoice(s.snapshots.enabled)).onChange((v) => {
          s.snapshots.enabled = fromChoice(v as SnapshotChoice);
          save();
        });
      });
  }
}

function toChoice(enabled: boolean | null): SnapshotChoice {
  return enabled === null ? 'ask' : enabled ? 'on' : 'off';
}

function fromChoice(choice: SnapshotChoice): boolean | null {
  return choice === 'ask' ? null : choice === 'on';
}
