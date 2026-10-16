import type { App, Plugin } from 'obsidian';
import type { SettingsStore } from '../settings';
import { SupportScripts } from '../support/installScripts';
import { notice, type Logger } from '../util/log';
import { SessionEvents } from './events';
import { KeyboardHooks } from './keyboard';
import { BridgeRouteRegistry } from './routes';
import { ServiceRegistry } from './services';
import { SpawnContributorRegistry } from './spawn';
import type { FeatureModule, PluginContext } from './types';

/** Upper bound for the ready gate: spawns are never blocked longer than this by a hanging module. */
export const READY_TIMEOUT_MS = 20_000;

export interface RuntimeOptions {
  app: App;
  plugin: Plugin;
  settingsStore: SettingsStore;
  vaultPath: string;
  pluginDir: string;
  log: Logger;
  readyTimeoutMs?: number;
}

/**
 * Builds the `PluginContext`, runs the feature modules through register → ready → unload and owns the
 * ready gate. One instance per plugin load.
 */
export class PluginRuntime {
  readonly ctx: PluginContext;
  private readonly modules: FeatureModule[] = [];
  private readonly registered = new Set<FeatureModule>();
  private readonly unloadCallbacks: Array<() => void | Promise<void>> = [];
  private readonly settingsDisposers: Array<() => void> = [];
  private resolveReady!: () => void;
  private readyDone = false;
  private unloading = false;
  private readonly log: Logger;
  private readonly readyTimeoutMs: number;

  constructor(private readonly opts: RuntimeOptions) {
    this.log = opts.log;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const report = (message: string, err?: unknown): void => {
      if (err === undefined) this.log.warn(message);
      else this.log.error(message, err);
    };
    const ready = new Promise<void>((resolve) => (this.resolveReady = resolve));
    const services = new ServiceRegistry();
    const spawn = new SpawnContributorRegistry(report);
    const keyboard = new KeyboardHooks(report);
    const routes = new BridgeRouteRegistry();
    const sessionEvents = new SessionEvents(report);
    const supportScripts = new SupportScripts(opts.pluginDir, this.log.child('support'));
    const store = opts.settingsStore;
    const isUnloading = () => this.unloading;

    this.ctx = {
      app: opts.app,
      plugin: opts.plugin,
      settings: store.settings,
      saveSettings: () => store.save(),
      onSettingsChange: (listener) => {
        const dispose = store.onChange(listener);
        this.settingsDisposers.push(dispose);
        return dispose;
      },
      vaultPath: opts.vaultPath,
      pluginDir: opts.pluginDir,
      log: this.log,
      services,
      spawn,
      keyboard,
      routes,
      sessionEvents,
      supportScripts,
      ready,
      isReady: () => this.readyDone,
      get unloading() {
        return isUnloading();
      },
      onUnload: (cb) => {
        if (this.unloading) this.runCallback('onUnload callback', cb);
        else this.unloadCallbacks.push(cb);
      },
    };
  }

  /**
   * Registers every module in order (awaiting each `register`), then starts the ready phase in the background:
   * support-script install + every module's `ready()` concurrently. Resolves after registration.
   */
  async start(modules: FeatureModule[]): Promise<void> {
    for (const mod of modules) {
      this.modules.push(mod);
      try {
        await mod.register(this.ctx);
        this.registered.add(mod);
      } catch (err) {
        this.log.error(`module "${mod.id}" failed to register`, err);
        notice(loadFailureNotice(mod));
      }
    }
    void this.runReadyPhase();
  }

  private async runReadyPhase(): Promise<void> {
    const pending = new Set<string>();
    const track = (id: string, work: () => Promise<unknown>): Promise<void> => {
      pending.add(id);
      return Promise.resolve()
        .then(work)
        .then(
          () => undefined,
          (err) => this.log.error(`"${id}" ready failed`, err),
        )
        .finally(() => pending.delete(id));
    };
    const tasks = [track('support-scripts', () => this.ctx.supportScripts.install())];
    for (const mod of this.modules) {
      if (this.registered.has(mod) && mod.ready) tasks.push(track(mod.id, () => mod.ready!(this.ctx)));
    }
    let timer: number | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = window.setTimeout(() => resolve('timeout'), this.readyTimeoutMs);
    });
    const outcome = await Promise.race([Promise.all(tasks).then(() => 'done' as const), timeout]);
    if (timer) window.clearTimeout(timer);
    if (outcome === 'timeout') this.log.warn(`ready gate timed out after ${this.readyTimeoutMs} ms; still pending: ${[...pending].join(', ')}`);
    if (this.unloading) return;
    this.readyDone = true;
    this.resolveReady();
  }

  /** Plugin unload: `onUnload` callbacks (newest first), then modules' `unload()` in reverse order. */
  unload(): void {
    if (this.unloading) return;
    this.unloading = true;
    for (const cb of this.unloadCallbacks.splice(0).reverse()) this.runCallback('onUnload callback', cb);
    for (const mod of [...this.modules].reverse()) {
      if (mod.unload) this.runCallback(`module "${mod.id}" unload`, () => mod.unload!(this.ctx));
    }
    for (const dispose of this.settingsDisposers.splice(0)) dispose();
    this.ctx.sessionEvents.clear();
    this.ctx.keyboard.clear();
    this.ctx.routes.clear();
    this.ctx.services.clear();
  }

  private runCallback(label: string, cb: () => void | Promise<void>): void {
    try {
      const r = cb();
      if (r && typeof r.then === 'function') {
        r.catch((err) => this.log.error(`${label} failed`, err));
      }
    } catch (err) {
      this.log.error(`${label} failed`, err);
    }
  }
}

/** One plain sentence for a part that failed to load — never the internal module id. */
export function loadFailureNotice(mod: Pick<FeatureModule, 'label'>): string {
  const what = mod.label?.trim() || 'a part of AI Terminal';
  return `AI Terminal: ${what} failed to load. Reload the plugin; details are in the developer console.`;
}
