import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App, Plugin } from 'obsidian';
import { PluginRuntime } from '../../src/core/runtime';
import { TypedEmitter, type FeatureModule, type PluginContext, type SessionEventMap } from '../../src/core';
import type { PtyLaunchOptions, PtyService } from '../../src/pty/index';
import type { PtyExit, PtyProcess, PtyProcessEvents } from '../../src/pty/PtyProcess';
import type { MirrorSnapshot } from '../../src/session/mirror';
import { SessionRegistry, type SessionRegistryOptions } from '../../src/session/SessionRegistry';
import type { SessionState } from '../../src/core/types';
import type { TerminalSink, TerminalSize } from '../../src/session/types';
import { SettingsStore } from '../../src/settings';
import { createLogger, type LogSink } from '../../src/util/log';
import { createManifest, createMockApp, Plugin as MockPlugin } from '../mocks/obsidian';

class TestPlugin extends MockPlugin {}

const decoder = new TextDecoder();
export function toText(chunks: ReadonlyArray<string | Uint8Array>): string {
  return chunks.map((c) => (typeof c === 'string' ? c : decoder.decode(c))).join('');
}

/** Scriptable stand-in for `PtyProcess` (no helper, no child process). */
export class FakePtyProcess {
  static nextPid = 4000;
  readonly pid = FakePtyProcess.nextPid++;
  programPid: number | undefined = this.pid + 1;
  readonly command: string;
  readonly args: readonly string[];
  cols: number;
  rows: number;
  readonly writes: Array<string | Uint8Array> = [];
  readonly resizes: Array<[number, number]> = [];
  killReason: string | undefined;
  hasExited = false;
  readonly exited: Promise<PtyExit>;
  private resolveExited!: (exit: PtyExit) => void;
  private exitInfo: PtyExit | null = null;
  private readonly emitter = new TypedEmitter<PtyProcessEvents>();

  constructor(readonly opts: PtyLaunchOptions) {
    this.command = opts.command;
    this.args = [...(opts.args ?? [])];
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.exited = new Promise((resolve) => (this.resolveExited = resolve));
  }

  on<K extends keyof PtyProcessEvents>(event: K, listener: (payload: PtyProcessEvents[K]) => void) {
    const dispose = this.emitter.on(event, listener);
    if (event === 'exit' && this.exitInfo) {
      const info = this.exitInfo;
      queueMicrotask(() => (listener as (p: PtyExit) => void)(info));
    }
    return dispose;
  }

  write(data: string | Uint8Array): void {
    if (this.hasExited || this.killReason !== undefined) return;
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push([cols, rows]);
  }

  /** Like the helper: SIGHUP to the program → exit code 129, reported asynchronously. */
  kill(reason = 'stopped'): void {
    if (this.hasExited || this.killReason !== undefined) return;
    this.killReason = reason;
    setTimeout(() => this.exit(129), 1);
  }

  emitData(text: string): void {
    this.emitter.emit('data', new TextEncoder().encode(text));
  }

  exit(exitCode: number | null, extra: Partial<PtyExit> = {}): void {
    if (this.exitInfo) return;
    const info: PtyExit = { exitCode, signal: null, notFound: false, command: this.command, ...extra };
    if (this.killReason !== undefined) info.killReason = this.killReason;
    this.exitInfo = info;
    this.hasExited = true;
    this.emitter.emit('exit', info);
    this.resolveExited(info);
  }

  input(): string {
    return toText(this.writes);
  }
}

export class FakePtyService implements PtyService {
  readonly helperPath = '/fake/pty_bridge.py';
  readonly spawned: FakePtyProcess[] = [];
  readonly calls: PtyLaunchOptions[] = [];
  failWith: Error | null = null;
  onSpawn: ((proc: FakePtyProcess) => void) | null = null;

  live(): PtyProcess[] {
    return this.spawned.filter((p) => !p.hasExited) as unknown as PtyProcess[];
  }

  async spawn(opts: PtyLaunchOptions): Promise<PtyProcess> {
    this.calls.push(opts);
    if (this.failWith) throw this.failWith;
    const proc = new FakePtyProcess(opts);
    this.spawned.push(proc);
    this.onSpawn?.(proc);
    return proc as unknown as PtyProcess;
  }

  get last(): FakePtyProcess {
    const p = this.spawned[this.spawned.length - 1];
    if (!p) throw new Error('nothing spawned');
    return p;
  }
}

/** Records everything the registry does to a view. */
export class FakeSink implements TerminalSink {
  readonly terminal = undefined;
  readonly chunks: Array<string | Uint8Array> = [];
  readonly restores: MirrorSnapshot[] = [];
  readonly identities: Array<{ panelId: string; sessionId: string | undefined }> = [];
  readonly states: SessionState[] = [];
  size: TerminalSize | null = { cols: 100, rows: 30 };
  onRestore: ((snapshot: MirrorSnapshot) => void | Promise<void>) | null = null;

  constructor(readonly name = 'sink') {}

  write(data: string | Uint8Array): void {
    this.chunks.push(data);
  }

  async restore(snapshot: MirrorSnapshot): Promise<void> {
    this.restores.push(snapshot);
    await this.onRestore?.(snapshot);
  }

  measure(): TerminalSize | null {
    return this.size;
  }

  identityChanged(identity: { panelId: string; sessionId: string | undefined }): void {
    this.identities.push(identity);
  }

  stateChanged(state: SessionState): void {
    this.states.push(state);
  }

  text(): string {
    return toText(this.chunks);
  }
}

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export type RecordedEvent = { [K in keyof SessionEventMap]: [K, SessionEventMap[K]] }[keyof SessionEventMap];

export interface Harness {
  runtime: PluginRuntime;
  ctx: PluginContext;
  app: ReturnType<typeof createMockApp>;
  plugin: TestPlugin;
  pty: FakePtyService;
  events: RecordedEvent[];
  logs: string[];
  /** Resolves the ready gate (only when created with `gated: true`). */
  release: () => void;
  registry: SessionRegistry;
}

export interface HarnessOptions {
  gated?: boolean;
  registry?: SessionRegistryOptions;
  extraModules?: FeatureModule[];
  /** Skip constructing a SessionRegistry (e.g. when the session module is under test). */
  noRegistry?: boolean;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  const app = createMockApp(vault);
  const plugin = new TestPlugin(app, createManifest());
  const store = new SettingsStore((d) => plugin.saveData(d));
  store.load(null);
  const logs: string[] = [];
  const push = (...a: unknown[]): void => {
    logs.push(a.join(' '));
  };
  const sink: LogSink = { debug: push, info: push, warn: push, error: push };
  const runtime = new PluginRuntime({
    app: app as unknown as App,
    plugin: plugin as unknown as Plugin,
    settingsStore: store,
    vaultPath: vault,
    pluginDir: vault,
    log: createLogger(undefined, sink),
  });
  const pty = new FakePtyService();
  const gate = deferred();
  if (!options.gated) gate.resolve();
  const modules: FeatureModule[] = [
    {
      id: 'fake-pty',
      register(ctx) {
        ctx.services.provide('pty', pty);
      },
      ready: () => gate.promise,
    },
    ...(options.extraModules ?? []),
  ];
  await runtime.start(modules);
  const events: RecordedEvent[] = [];
  const ctx = runtime.ctx;
  for (const name of ['session:spawning', 'session:started', 'session:exited', 'session:stopped'] as const) {
    ctx.sessionEvents.on(name, (payload) => events.push([name, payload] as RecordedEvent));
  }
  const registry = options.noRegistry ? (undefined as unknown as SessionRegistry) : new SessionRegistry(ctx, options.registry);
  return { runtime, ctx, app, plugin, pty, events, logs, release: gate.resolve, registry };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
