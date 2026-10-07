/** Which AI a snapshot was taken for. */
export type SnapshotAi = 'claude' | 'agy';

/**
 * Why a snapshot was taken: before a message (`prompt`), before an AI panel starts (`spawn`), before a restore
 * (`restore`, T10) or right after snapshots were turned on (`first`).
 */
export type SnapshotKind = 'prompt' | 'spawn' | 'restore' | 'first';

export interface SnapshotMeta {
  kind: SnapshotKind;
  ai?: SnapshotAi;
  panelId?: string;
  /** The user's message (Claude); only the first 200 characters are kept, redacted. */
  prompt?: string;
  /** Replaces the commit subject's leading words, e.g. "Before restore". */
  label?: string;
}

/**
 * - `committed`: a new commit holds the current notes (`commit`);
 * - `unchanged`: nothing changed since the last snapshot (`commit` = the snapshot that already holds this state, if any);
 * - `pending`: still running when the wait ended — git keeps going and commits later;
 * - `failed`: `reason` says why (the change flag stays set so the next request tries again);
 * - `disabled`: snapshots are off, git is unavailable, or the plugin is unloading.
 */
export type SnapshotStatus = 'committed' | 'unchanged' | 'pending' | 'failed' | 'disabled';

export interface SnapshotResult {
  status: SnapshotStatus;
  commit?: string;
  reason?: string;
}

/** One snapshot as listed for the restore modal (newest first). */
export interface SnapshotInfo {
  /** Full commit hash. */
  commit: string;
  /** Commit time, epoch milliseconds. */
  time: number;
  /** Commit subject, e.g. `Before Claude Code: "make this shorter" — 2026-10-07 14:03`. */
  subject: string;
  kind: SnapshotKind | 'unknown';
  ai?: SnapshotAi;
  panelId?: string;
  /** Up to 200 characters of the message that triggered it (Claude prompts only). */
  promptExcerpt?: string;
}

export type ChangeStatus = 'modified' | 'deleted' | 'created';

/** A tracked note that differs between a snapshot and the vault now (`created` = not in the snapshot). */
export interface ChangedFile {
  /** Vault-relative, `/`-separated, NFC. */
  path: string;
  status: ChangeStatus;
}

/** The `snapshots` service (T9) — T10 builds the restore command on it. */
export interface SnapshotsService {
  /** Snapshots are turned on for this vault and git works. */
  isEnabled(): boolean;
  /** git works (the store can be read even when snapshots are turned off). False until the startup check finished. */
  isAvailable(): boolean;
  /** Why git is unavailable, if it is. */
  unavailableReason(): string | undefined;
  /** Absolute path of this vault's history store (`~/.local/share/obsidian-ai-terminal/snapshots/<hash>.git`). */
  readonly storePath: string;
  /** Snapshots, newest first (default at most 500). Empty when no snapshot exists yet. */
  list(options?: { limit?: number }): Promise<SnapshotInfo[]>;
  /** Tracked notes that differ between `commit` and the vault now (runs in the snapshot queue). */
  changedSince(commit: string): Promise<ChangedFile[]>;
  /** `changedSince` for several snapshots with one scan of the vault. */
  changedSinceMany(commits: readonly string[]): Promise<Map<string, ChangedFile[]>>;
  /** Content of `path` in snapshot `commit`. Rejects if the file is not in that snapshot. */
  readFileAt(commit: string, path: string): Promise<Buffer>;
  /**
   * Takes a snapshot now, through the queue, whether or not the change flag is set, and whether or not snapshots are
   * turned on (as long as git works) — e.g. T10's `Before restore`. Waits until done unless `waitMs` is given.
   */
  snapshotNow(meta: SnapshotMeta, options?: { waitMs?: number }): Promise<SnapshotResult>;
  /**
   * Requests a snapshot (D31): when snapshots are on and the change flag is set, queues one and waits at most `waitMs`
   * (`pending` after that — git is never stopped). With the flag clear it only waits for a snapshot already in flight.
   */
  requestSnapshot(meta: SnapshotMeta, options: { waitMs: number }): Promise<SnapshotResult>;
  /** The "vault may have changed" hint (D31). */
  hasChanges(): boolean;
  markChanged(reason?: string): void;
  /** Resolves when no snapshot job is queued or running. */
  whenIdle(): Promise<void>;
}

declare module '../core/services' {
  interface ServiceMap {
    snapshots: SnapshotsService;
  }
}
