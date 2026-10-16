/**
 * "The vault may have changed" (D31). Set on plugin load, when snapshots are turned on and on vault
 * modify / create / delete / rename; cleared when a snapshot starts. Only a hint — git decides whether anything changed.
 */
export class ChangeFlag {
  private value = false;
  private why: string | undefined;

  set(reason = 'change'): void {
    this.value = true;
    this.why = reason;
  }

  clear(): void {
    this.value = false;
    this.why = undefined;
  }

  isSet(): boolean {
    return this.value;
  }

  /** What set it last (for logs). */
  get reason(): string | undefined {
    return this.why;
  }
}

export type Waited<T> = { done: true; value: T } | { done: false };

/** Waits for `promise` at most `ms` (Infinity = no limit). Never cancels the work behind it. */
export function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<Waited<T>> {
  const settled = promise.then((value): Waited<T> => ({ done: true, value }));
  if (!Number.isFinite(ms)) return settled;
  let timer: number | undefined;
  const timeout = new Promise<Waited<T>>((resolve) => {
    timer = window.setTimeout(() => resolve({ done: false }), Math.max(0, ms));
  });
  return Promise.race([settled, timeout]).finally(() => window.clearTimeout(timer));
}

/**
 * One git job at a time (D31, R12.17). A caller that stops waiting does not cancel its job: it stays in the queue
 * and later jobs start only after it finished, so two gits never race for `index.lock`.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  private idleWaiters: Array<() => void> = [];

  /** Jobs queued or running. */
  get size(): number {
    return this.count;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.count++;
    const result = this.tail.then(job);
    this.tail = result.then(
      () => this.finished(),
      () => this.finished(),
    );
    return result;
  }

  /** Resolves once no job is queued or running. */
  whenIdle(): Promise<void> {
    if (this.count === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private finished(): void {
    this.count--;
    if (this.count === 0) for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
