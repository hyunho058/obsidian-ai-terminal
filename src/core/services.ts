import type { Disposer } from './types';

/**
 * Typed service map. It is empty on purpose: each feature module declares the
 * services it publishes by augmenting this interface in its own file, e.g.
 *
 * ```ts
 * declare module '../core/services' {
 *   interface ServiceMap {
 *     pty: PtyFactory;
 *   }
 * }
 * ```
 *
 * Suggested keys: `shellEnv`, `pty` (T2) · `sessions` (T3) · `bridgeState`,
 * `bridgeServer` (T6) · `ide` (T7) · `agyBridge` (T8) · `snapshots` (T9).
 */
export interface ServiceMap {}

export type ServiceKey = keyof ServiceMap & string;

export class ServiceTimeoutError extends Error {
  constructor(readonly key: string, readonly timeoutMs: number) {
    super(`Service "${key}" was not provided within ${timeoutMs} ms`);
    this.name = 'ServiceTimeoutError';
  }
}

type Waiter = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer?: ReturnType<typeof setTimeout> };

/** Registry through which modules publish implementations to each other. */
export class ServiceRegistry {
  private readonly impls = new Map<string, unknown>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  /**
   * Publishes `impl` under `key`. Throws if the key is already provided.
   * The returned disposer removes it (only if it is still the same object).
   */
  provide<K extends ServiceKey>(key: K, impl: ServiceMap[K]): Disposer {
    if (this.impls.has(key)) throw new Error(`Service "${key}" is already provided`);
    this.impls.set(key, impl);
    const waiters = this.waiters.get(key);
    if (waiters) {
      this.waiters.delete(key);
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve(impl);
      }
    }
    return () => {
      if (this.impls.get(key) === impl) this.impls.delete(key);
    };
  }

  /** The implementation, or `undefined` if nothing has been provided (yet). */
  get<K extends ServiceKey>(key: K): ServiceMap[K] | undefined {
    return this.impls.get(key) as ServiceMap[K] | undefined;
  }

  /** The implementation; throws if missing. */
  require<K extends ServiceKey>(key: K): ServiceMap[K] {
    if (!this.impls.has(key)) throw new Error(`Service "${key}" is not available`);
    return this.impls.get(key) as ServiceMap[K];
  }

  has(key: ServiceKey): boolean {
    return this.impls.has(key);
  }

  /**
   * Resolves as soon as `key` is provided (immediately if it already is).
   * With `timeoutMs`, rejects with `ServiceTimeoutError` when it does not arrive in time —
   * use a timeout in `ready()` so a missing module cannot hang the ready gate.
   */
  whenAvailable<K extends ServiceKey>(key: K, timeoutMs?: number): Promise<ServiceMap[K]> {
    if (this.impls.has(key)) return Promise.resolve(this.impls.get(key) as ServiceMap[K]);
    return new Promise<ServiceMap[K]>((resolve, reject) => {
      const waiter: Waiter = { resolve: resolve as (v: unknown) => void, reject };
      let set = this.waiters.get(key);
      if (!set) this.waiters.set(key, (set = new Set()));
      set.add(waiter);
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          set?.delete(waiter);
          reject(new ServiceTimeoutError(key, timeoutMs));
        }, timeoutMs);
      }
    });
  }

  /** Drops all services and cancels pending timers (plugin unload). Pending waiters never resolve. */
  clear(): void {
    for (const set of this.waiters.values()) for (const w of set) if (w.timer) clearTimeout(w.timer);
    this.waiters.clear();
    this.impls.clear();
  }
}
