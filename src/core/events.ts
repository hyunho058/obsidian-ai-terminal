import type { ProfileId } from './constants';
import type { Disposer, SpawnPhase } from './types';

type ErrorReporter = (message: string, err?: unknown) => void;

/** Minimal typed event emitter. A throwing listener is reported and does not affect the others. */
export class TypedEmitter<M extends object> {
  private readonly listeners = new Map<keyof M, Set<(payload: never) => void>>();

  constructor(private readonly onError: ErrorReporter = (m, e) => console.error(m, e)) {}

  on<K extends keyof M>(event: K, listener: (payload: M[K]) => void): Disposer {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const fn = listener as (payload: never) => void;
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: M[K]) => void)(payload);
      } catch (err) {
        this.onError(`listener for "${String(event)}" failed`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** Fields shared by every session event. */
export interface SessionEventBase {
  panelId: string;
  profile: ProfileId;
  /** Conversation id (Claude `--session-id` / `--resume` UUID), when known. */
  sessionId?: string;
}

export interface SessionSpawningEvent extends SessionEventBase {
  phase: SpawnPhase;
}

export interface SessionStartedEvent extends SessionEventBase {
  phase: SpawnPhase;
  /** pid of the PTY helper process. */
  pid?: number;
}

export interface SessionExitedEvent extends SessionEventBase {
  /** Program exit code; `null` if it ended by a signal or the code is unknown. */
  exitCode: number | null;
  /** Milliseconds between `session:started` and the exit. */
  runtimeMs: number;
}

export interface SessionStoppedEvent extends SessionEventBase {
  /** Why the registry stopped the session (e.g. 'close', 'unload', 'grace-expired', 'restore'). */
  reason: string;
}

/**
 * Session lifecycle, emitted by the session registry (T3):
 * - `session:spawning` — after the ready gate, `beforeSpawn` hooks and contributors, right before the helper is spawned;
 * - `session:started` — the helper process is running;
 * - `session:exited` — the program ended (by itself or because it was stopped);
 * - `session:stopped` — the registry tore the session down for good (panel closed, grace expired, unload).
 */
export interface SessionEventMap {
  'session:spawning': SessionSpawningEvent;
  'session:started': SessionStartedEvent;
  'session:exited': SessionExitedEvent;
  'session:stopped': SessionStoppedEvent;
}

export interface BeforeSpawnContext extends SessionEventBase {
  phase: SpawnPhase;
  vaultPath: string;
  /** Prints a line in the panel (local display only, never sent to the program). */
  print(line: string): void;
}

/** Awaited before every spawn (new / restore / restart). May take time (e.g. a dialog or a snapshot). */
export type BeforeSpawnHook = (ctx: BeforeSpawnContext) => Promise<void> | void;

export class SessionEvents extends TypedEmitter<SessionEventMap> {
  private readonly hooks: BeforeSpawnHook[] = [];

  constructor(private readonly report: ErrorReporter = (m, e) => console.error(m, e)) {
    super(report);
  }

  /** Registers a hook that the launcher awaits before spawning. Hooks run one after another in registration order. */
  beforeSpawn(hook: BeforeSpawnHook): Disposer {
    this.hooks.push(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /**
   * Runs every `beforeSpawn` hook sequentially (called by T3's launcher after the ready gate and
   * before the spawn contributors). Never throws: a failing hook is reported and the spawn goes on.
   * Hooks are responsible for their own timeouts.
   */
  async runBeforeSpawn(ctx: BeforeSpawnContext): Promise<void> {
    for (const hook of [...this.hooks]) {
      try {
        await hook(ctx);
      } catch (err) {
        this.report('beforeSpawn hook failed', err);
      }
    }
  }

  clear(): void {
    super.clear();
    this.hooks.length = 0;
  }
}
