import type { App, Plugin } from 'obsidian';
import type { Terminal } from '@xterm/xterm';
import type { AiTerminalSettings, SettingsChangeListener } from '../settings';
import type { SupportScripts } from '../support/installScripts';
import type { Logger } from '../util/log';
import type { ProfileId } from './constants';
import type { SessionEvents } from './events';
import type { KeyboardHooks } from './keyboard';
import type { BridgeRouteRegistry } from './routes';
import type { ServiceRegistry } from './services';
import type { SpawnContributorRegistry } from './spawn';

export type Disposer = () => void;

/** Why a program is being spawned: a new panel, a panel restored from the workspace layout, or Enter-to-restart. */
export type SpawnPhase = 'new' | 'restore' | 'restart';

export type SessionState = 'starting' | 'running' | 'exited' | 'stopped';

/** Persisted view state of a terminal panel (D4). */
export interface TerminalViewState {
  profile: ProfileId;
  panelId: string;
  sessionId?: string;
}

/**
 * The terminal panel as seen by keyboard hooks and other modules. Implemented by T3
 * (one handle per session; `terminal` is the xterm of the currently attached view).
 */
export interface TerminalPanelHandle {
  readonly panelId: string;
  readonly profile: ProfileId;
  readonly sessionId: string | undefined;
  readonly state: SessionState;
  /** xterm instance of the attached view; `undefined` while no view is attached. */
  readonly terminal: Terminal | undefined;
  /** Writes data to the program (PTY stdin), bypassing any input hold. */
  sendInput(data: string): void;
  /** Shows text in the panel only (not sent to the program). Use `\r\n` line endings. */
  print(text: string): void;
  /**
   * Queues user input (typing, pastes) instead of sending it, until the returned release function is called;
   * release flushes the queue in order. Holds may nest; input flows again when every hold is released.
   */
  holdInput(): () => void;
}

/**
 * A feature module (one per later task). `main.ts` calls, in module order:
 * 1. `register(ctx)` — synchronous-ish wiring only: views, commands, services, contributors, hooks, routes,
 *    support-script names. Keep it fast; Obsidian awaits it during plugin load.
 * 2. `ready(ctx)` — slow startup work (env capture, servers listening, agy entry …). All modules' `ready()`
 *    run concurrently; `ctx.ready` resolves when every one has settled. Never let it hang: bound every wait.
 * 3. `unload(ctx)` on plugin unload, in reverse module order (after the `ctx.onUnload` callbacks).
 */
export interface FeatureModule {
  /** Short id used in logs, e.g. `pty`. */
  readonly id: string;
  /** Plain name shown to the user if this part fails to load, e.g. "snapshots". Without it the Notice stays generic. */
  readonly label?: string;
  register(ctx: PluginContext): void | Promise<void>;
  ready?(ctx: PluginContext): Promise<void>;
  unload?(ctx: PluginContext): void | Promise<void>;
}

/** Everything a feature module gets. Created once per plugin load by `PluginRuntime`. */
export interface PluginContext {
  readonly app: App;
  readonly plugin: Plugin;
  /** Live settings object — always the same reference; read it at use time. */
  readonly settings: AiTerminalSettings;
  /** Persists `settings` and notifies `onSettingsChange` listeners. */
  saveSettings(): Promise<void>;
  /** Called after every save with the new settings and a copy of the previous ones. */
  onSettingsChange(listener: SettingsChangeListener): Disposer;
  /** Absolute vault root (`FileSystemAdapter.getBasePath()`). */
  readonly vaultPath: string;
  /** Absolute path of the installed plugin folder (holds `main.js` and the bundled `*.py` files). */
  readonly pluginDir: string;
  /** Redacting logger (see `util/log.ts`); use `log.child('<module>')`. */
  readonly log: Logger;
  readonly services: ServiceRegistry;
  readonly spawn: SpawnContributorRegistry;
  readonly keyboard: KeyboardHooks;
  readonly routes: BridgeRouteRegistry;
  readonly sessionEvents: SessionEvents;
  readonly supportScripts: SupportScripts;
  /** Resolves when every module's `ready()` has settled (or the ready timeout passed). Never rejects. */
  readonly ready: Promise<void>;
  isReady(): boolean;
  /** True once plugin unload has begun (no confirmation dialogs from then on). */
  readonly unloading: boolean;
  /**
   * Runs `cb` on plugin unload (newest first, before the modules' `unload()`). Obsidian does not await
   * unload — do essential cleanup (lock files) synchronously.
   */
  onUnload(cb: () => void | Promise<void>): void;
}
