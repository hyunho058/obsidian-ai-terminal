import type { Logger } from '../util/log';
import type { GitAvailability } from './git';
import { ChangeFlag, SerialQueue, waitAtMost } from './queue';
import { SnapshotError, type SnapshotStore } from './store';
import type { ChangedFile, SnapshotInfo, SnapshotMeta, SnapshotResult, SnapshotsService } from './types';

export interface SnapshotServiceOptions {
  store: SnapshotStore;
  /** `settings.snapshots.enabled === true`, read at use time. */
  isTurnedOn: () => boolean;
  /** git availability probe (R12.16); run once. */
  checkGit: () => Promise<GitAvailability>;
  log: Logger;
  /** Called at most once per Obsidian session and store with the nested repositories found (R12.14). */
  onNestedRepositories?: (dirs: string[]) => void;
  now?: () => Date;
}

const NESTED_KEY = Symbol.for('obsidian-ai-terminal.snapshot-nested-reported');

function nestedReported(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  let set = g[NESTED_KEY];
  if (!set) g[NESTED_KEY] = set = new Set();
  return set;
}

/** The `snapshots` service: change flag + serialized queue around the store (D31). */
export class SnapshotService implements SnapshotsService {
  readonly flag = new ChangeFlag();
  private readonly queue = new SerialQueue();
  private availability: GitAvailability | undefined;
  private availabilityCheck: Promise<GitAvailability> | undefined;
  /** Latest snapshot job (queued or running). */
  private inFlight: Promise<SnapshotResult> | null = null;
  private lastCommit: string | undefined;
  private nestedChecked = false;
  private disposed = false;

  constructor(private readonly opts: SnapshotServiceOptions) {}

  get storePath(): string {
    return this.opts.store.storePath;
  }

  get store(): SnapshotStore {
    return this.opts.store;
  }

  /** Runs the git probe once; later calls return the same answer. */
  checkAvailability(): Promise<GitAvailability> {
    if (!this.availabilityCheck) {
      this.availabilityCheck = this.opts
        .checkGit()
        .catch((err): GitAvailability => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }))
        .then((a) => {
          this.availability = a;
          if (a.ok) this.opts.log.debug(`snapshots use ${a.version}`);
          else this.opts.log.warn(`snapshots unavailable: ${a.reason}`);
          return a;
        });
    }
    return this.availabilityCheck;
  }

  isAvailable(): boolean {
    return !this.disposed && this.availability?.ok === true;
  }

  unavailableReason(): string | undefined {
    return this.availability && !this.availability.ok ? this.availability.reason : undefined;
  }

  isEnabled(): boolean {
    return this.isAvailable() && this.opts.isTurnedOn();
  }

  hasChanges(): boolean {
    return this.flag.isSet();
  }

  markChanged(reason = 'change'): void {
    this.flag.set(reason);
  }

  /** A snapshot job is queued or running. */
  isBusy(): boolean {
    return this.inFlight !== null;
  }

  async requestSnapshot(meta: SnapshotMeta, options: { waitMs: number }): Promise<SnapshotResult> {
    await this.checkAvailability();
    if (!this.isEnabled()) return { status: 'disabled' };
    if (!this.flag.isSet()) {
      // Nothing changed since the last snapshot started — but that one may still be writing: wait for it (bounded).
      const current = this.inFlight;
      if (!current) return this.lastCommit ? { status: 'unchanged', commit: this.lastCommit } : { status: 'unchanged' };
      return this.wait(current, options.waitMs);
    }
    return this.wait(this.enqueue(meta, true), options.waitMs);
  }

  async snapshotNow(meta: SnapshotMeta, options: { waitMs?: number } = {}): Promise<SnapshotResult> {
    await this.checkAvailability();
    if (!this.isAvailable()) return { status: 'disabled', reason: this.unavailableReason() ?? 'snapshots are not available' };
    return this.wait(this.enqueue(meta, false), options.waitMs ?? Infinity);
  }

  async list(options: { limit?: number } = {}): Promise<SnapshotInfo[]> {
    await this.requireGit();
    return this.opts.store.list(options.limit);
  }

  async changedSince(commit: string): Promise<ChangedFile[]> {
    return (await this.changedSinceMany([commit])).get(commit) ?? [];
  }

  async changedSinceMany(commits: readonly string[]): Promise<Map<string, ChangedFile[]>> {
    await this.requireGit();
    const list = [...commits];
    return this.queue.run(() => this.opts.store.changedSince(list));
  }

  async readFileAt(commit: string, filePath: string): Promise<Buffer> {
    await this.requireGit();
    return this.opts.store.readFileAt(commit, filePath);
  }

  whenIdle(): Promise<void> {
    return this.queue.whenIdle();
  }

  /** Plugin unload: queued jobs that have not started are skipped; a running git finishes on its own. */
  dispose(): void {
    this.disposed = true;
  }

  private async requireGit(): Promise<void> {
    await this.checkAvailability();
    if (!this.isAvailable()) throw new SnapshotError(this.unavailableReason() ?? 'snapshots are not available');
  }

  private enqueue(meta: SnapshotMeta, ifChanged: boolean): Promise<SnapshotResult> {
    const job: Promise<SnapshotResult> = this.queue
      .run(() => this.runSnapshot(meta, ifChanged))
      .finally(() => {
        if (this.inFlight === job) this.inFlight = null;
      });
    this.inFlight = job;
    return job;
  }

  private async wait(job: Promise<SnapshotResult>, waitMs: number): Promise<SnapshotResult> {
    const r = await waitAtMost(job, waitMs);
    return r.done ? r.value : { status: 'pending' };
  }

  private async runSnapshot(meta: SnapshotMeta, ifChanged: boolean): Promise<SnapshotResult> {
    if (this.disposed) return { status: 'disabled' };
    if (ifChanged) {
      if (!this.opts.isTurnedOn()) return { status: 'disabled' };
      // An earlier job started after the last change and already covers this request.
      if (!this.flag.isSet()) return this.lastCommit ? { status: 'unchanged', commit: this.lastCommit } : { status: 'unchanged' };
    }
    this.flag.clear();
    const started = Date.now();
    try {
      const r = await this.opts.store.snapshot(meta, this.opts.now?.() ?? new Date());
      if (r.commit) this.lastCommit = r.commit;
      this.opts.log.debug(`snapshot (${meta.kind}${meta.ai ? `, ${meta.ai}` : ''}): ${r.status} in ${Date.now() - started} ms`);
      this.checkNestedOnce();
      return r.commit ? { status: r.status, commit: r.commit } : { status: r.status };
    } catch (err) {
      this.flag.set('snapshot failed');
      const reason = err instanceof SnapshotError ? err.message : `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      if (!(err instanceof SnapshotError)) this.opts.log.error('snapshot failed', err);
      else this.opts.log.warn(`snapshot failed: ${reason}`);
      return { status: 'failed', reason };
    }
  }

  private checkNestedOnce(): void {
    if (this.nestedChecked || !this.opts.onNestedRepositories) return;
    this.nestedChecked = true;
    const reported = nestedReported();
    if (reported.has(this.storePath)) return;
    void this.opts.store
      .nestedRepositories()
      .then((dirs) => {
        if (dirs.length === 0 || reported.has(this.storePath) || this.disposed) return;
        reported.add(this.storePath);
        this.opts.onNestedRepositories?.(dirs);
      })
      .catch((err) => this.opts.log.debug('nested repository check failed', err));
  }
}
