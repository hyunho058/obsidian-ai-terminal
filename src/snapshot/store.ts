import { createHash } from 'crypto';
import { promises as fs, existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR_NAME } from '../core/constants';
import type { Logger } from '../util/log';
import { GitRunner, GitSpawnError, gitFailureReason, runningLockingGit, whenLockingGitIdle, type GitResult } from './git';
import { commitMessage, parseCommit } from './messages';
import type { ChangedFile, SnapshotInfo, SnapshotMeta } from './types';

/** Note types that are snapshotted (D31); attachments are not. */
export const TRACKED_PATTERNS: readonly string[] = ['*.md', '*.canvas', '*.base'];
/** Folders never snapshotted, besides the vault's config folder (`app.vault.configDir`). */
export const EXCLUDED_DIRS: readonly string[] = ['.trash'];
const VAULT_PATH_KEY = 'obsidian-ai-terminal.vaultpath';
const DEFAULT_LIST_LIMIT = 500;

/** Store config written once at creation (the store is only ever used through this plugin). */
const STORE_CONFIG: ReadonlyArray<[string, string]> = [
  ['core.bare', 'false'],
  ['core.untrackedCache', 'true'],
  ['core.precomposeunicode', 'true'],
  ['core.quotepath', 'false'],
  ['core.autocrlf', 'false'],
  // Cloud-synced vaults change ctime / inode without changing content; mtime + size are enough.
  ['core.trustctime', 'false'],
  ['core.checkStat', 'minimal'],
  ['gc.autoDetach', 'false'],
  ['maintenance.autoDetach', 'false'],
];

/** A snapshot could not be taken or read; `message` is a short, user-facing reason. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** `~/.local/share/obsidian-ai-terminal/snapshots/<sha256(vaultPath)[:16]>.git` (D32). */
export function storePathFor(vaultPath: string, home: string = os.homedir()): string {
  const hash = createHash('sha256').update(vaultPath).digest('hex').slice(0, 16);
  return path.join(home, '.local', 'share', DATA_DIR_NAME, 'snapshots', `${hash}.git`);
}

/** Pathspecs of the snapshotted notes (R12.12): note types anywhere, minus config / trash folders. */
export function snapshotPathspecs(configDir: string): string[] {
  const dirs = new Set(EXCLUDED_DIRS);
  const cfg = configDir.replace(/^\/+|\/+$/g, '');
  if (cfg) dirs.add(cfg);
  return [...TRACKED_PATTERNS, ...[...dirs].map((d) => `:(exclude)${d}/**`)];
}

const COMMIT_RE = /^[0-9a-f]{7,64}$/i;

export function assertCommit(commit: string): void {
  if (!COMMIT_RE.test(commit)) throw new SnapshotError(`not a snapshot id: ${JSON.stringify(commit)}`);
}

export interface SnapshotStoreOptions {
  vaultPath: string;
  git: GitRunner;
  /** Defaults to `storePathFor(vaultPath)`. */
  storePath?: string;
  /** `app.vault.configDir`. */
  configDir: string;
  log?: Logger;
}

/**
 * The external history store of one vault (D32): `git --git-dir=<store> --work-tree=<vault>`. Nothing is ever written
 * inside the vault. Callers serialize mutating calls (`snapshot`, `changedSince`) through the snapshot queue.
 */
export class SnapshotStore {
  readonly storePath: string;
  readonly vaultPath: string;
  readonly pathspecs: string[];
  private initialized = false;

  constructor(private readonly opts: SnapshotStoreOptions) {
    this.vaultPath = opts.vaultPath;
    this.storePath = opts.storePath ?? storePathFor(opts.vaultPath);
    this.pathspecs = snapshotPathspecs(opts.configDir);
  }

  /** The store has been created (it may still have no commit). */
  exists(): boolean {
    return existsSync(path.join(this.storePath, 'HEAD'));
  }

  /** Creates the store if needed and checks it belongs to this vault. */
  async ensureInit(): Promise<void> {
    if (this.initialized && this.exists()) return;
    this.initialized = false;
    const parent = path.dirname(this.storePath);
    try {
      // Shared parents (e.g. ~/.local/share) keep the default mode; the plugin's own folders are private.
      await fs.mkdir(path.dirname(path.dirname(parent)), { recursive: true });
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new SnapshotError(`cannot create ${parent}: ${(err as Error).message}`);
    }
    if (!this.exists()) {
      const r = await this.git(['-c', 'init.defaultBranch=main', 'init', '-q', '--bare', '--template=', this.storePath], { cwd: parent, raw: true });
      if (r.code !== 0) throw new SnapshotError(`cannot create the snapshot store: ${gitFailureReason(r)}`);
    }
    const recorded = await this.git(['config', '--get', VAULT_PATH_KEY], { readOnly: true, cwd: parent });
    const recordedPath = recorded.stdout.toString('utf8').trim();
    if (recorded.code === 0 && recordedPath) {
      if (recordedPath !== this.vaultPath) throw new SnapshotError(`the snapshot store ${this.storePath} belongs to another vault (${recordedPath})`);
    } else {
      for (const [key, value] of [...STORE_CONFIG, [VAULT_PATH_KEY, this.vaultPath] as [string, string]]) {
        const r = await this.git(['config', key, value], { cwd: parent });
        if (r.code !== 0) throw new SnapshotError(`cannot configure the snapshot store: ${gitFailureReason(r)}`);
      }
    }
    this.initialized = true;
  }

  /**
   * Stages every note and commits if anything differs from the last snapshot (R12.5). Waits for git processes
   * a previous plugin instance left running, then removes stale lock files (R12.11).
   */
  async snapshot(meta: SnapshotMeta, now: Date = new Date()): Promise<{ status: 'committed' | 'unchanged'; commit?: string }> {
    await this.prepareWrite();
    await this.stage();
    const diff = await this.git(['diff', '--cached', '--quiet', '--', ...this.pathspecs]);
    if (diff.code === 0) return { status: 'unchanged', commit: await this.head() };
    if (diff.code !== 1) throw new SnapshotError(gitFailureReason(diff));
    const commit = await this.git(['commit', '-q', '--no-verify', '--no-gpg-sign', '--cleanup=whitespace', '-F', '-'], { input: commitMessage(meta, now) });
    if (commit.code !== 0) throw new SnapshotError(gitFailureReason(commit));
    const head = await this.head();
    if (!head) throw new SnapshotError('the commit was not recorded');
    return { status: 'committed', commit: head };
  }

  /** Current HEAD commit, or undefined while the store has no snapshot. */
  async head(): Promise<string | undefined> {
    if (!this.exists()) return undefined;
    const r = await this.git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { readOnly: true });
    const out = r.stdout.toString('utf8').trim();
    return r.code === 0 && COMMIT_RE.test(out) ? out : undefined;
  }

  async list(limit = DEFAULT_LIST_LIMIT): Promise<SnapshotInfo[]> {
    if (!(await this.head())) return [];
    const n = Math.max(1, Math.floor(limit));
    const r = await this.git(['log', '-z', `-n${n}`, '--format=%H%x1f%ct%x1f%B', 'HEAD', '--'], { readOnly: true });
    if (r.code !== 0) throw new SnapshotError(gitFailureReason(r));
    const out: SnapshotInfo[] = [];
    for (const record of r.stdout.toString('utf8').split('\0')) {
      const trimmed = record.replace(/^\n+/, '');
      if (!trimmed) continue;
      const [hash = '', ct = '0', ...rest] = trimmed.split('\x1f');
      if (!COMMIT_RE.test(hash)) continue;
      out.push(parseCommit(hash, Number(ct) || 0, rest.join('\x1f')));
    }
    return out;
  }

  /**
   * Tracked notes that differ between each snapshot and the vault now. Stages the current notes into the store's index
   * first (the same scan a snapshot does — nothing is committed).
   */
  async changedSince(commits: readonly string[]): Promise<Map<string, ChangedFile[]>> {
    for (const c of commits) assertCommit(c);
    const result = new Map<string, ChangedFile[]>();
    if (commits.length === 0) return result;
    if (!this.exists()) throw new SnapshotError('no snapshot has been taken yet');
    await this.prepareWrite();
    await this.stage();
    for (const commit of commits) {
      if (result.has(commit)) continue;
      const r = await this.git(['diff', '--cached', '--name-status', '-z', '--no-renames', commit, '--', ...this.pathspecs]);
      if (r.code !== 0) throw new SnapshotError(gitFailureReason(r));
      result.set(commit, parseNameStatus(r.stdout));
    }
    return result;
  }

  async readFileAt(commit: string, filePath: string): Promise<Buffer> {
    assertCommit(commit);
    const rel = filePath.normalize('NFC').replace(/^\/+/, '');
    if (!rel) throw new SnapshotError('empty path');
    const r = await this.git(['cat-file', 'blob', `${commit}:${rel}`], { readOnly: true });
    if (r.code !== 0) throw new SnapshotError(`"${rel}" is not in snapshot ${commit.slice(0, 8)}`);
    return r.stdout;
  }

  /** Folders inside the vault that are git repositories of their own (R12.14) — git cannot snapshot their notes. */
  async nestedRepositories(): Promise<string[]> {
    if (!this.exists()) return [];
    const excludes = this.pathspecs.filter((p) => p.startsWith(':(exclude)'));
    const r = await this.git(['ls-files', '-o', '-z', '--', ...excludes], { readOnly: true });
    if (r.code !== 0) return [];
    return r.stdout
      .toString('utf8')
      .split('\0')
      .filter((p) => p.endsWith('/'))
      .map((p) => p.slice(0, -1))
      .sort();
  }

  /** Removes `index.lock` / `HEAD.lock` / branch locks if no plugin git runs in the store (R12.11). True if removed. */
  async clearStaleLocks(): Promise<boolean> {
    if (runningLockingGit(this.storePath) > 0) return false;
    const candidates = [path.join(this.storePath, 'index.lock'), path.join(this.storePath, 'HEAD.lock')];
    try {
      for (const name of await fs.readdir(path.join(this.storePath, 'refs', 'heads'))) {
        if (name.endsWith('.lock')) candidates.push(path.join(this.storePath, 'refs', 'heads', name));
      }
    } catch {
      // no refs yet
    }
    let removed = false;
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      await fs.rm(file, { force: true });
      this.opts.log?.warn(`removed stale ${path.basename(file)} from the snapshot store`);
      removed = true;
    }
    return removed;
  }

  private async prepareWrite(): Promise<void> {
    try {
      const st = await fs.stat(this.vaultPath);
      if (!st.isDirectory()) throw new Error('not a folder');
    } catch {
      throw new SnapshotError(`the vault folder ${this.vaultPath} is not accessible`);
    }
    await this.ensureInit();
    await whenLockingGitIdle(this.storePath);
    await this.clearStaleLocks();
  }

  /**
   * Stages the vault's notes like `git add -f -A -- <pathspecs>` (R12.12: ignore rules are not applied, deletions are
   * staged). `ls-files -c -o` + `update-index --add --remove` is used because `git add` aborts with "pathspec '*.canvas'
   * did not match any files" in a vault without such a file, and tolerates files deleted between the two steps.
   */
  private async stage(): Promise<void> {
    const files = await this.git(['ls-files', '-z', '-c', '-o', '--', ...this.pathspecs], { readOnly: true });
    if (files.code !== 0) throw new SnapshotError(gitFailureReason(files));
    if (files.stdout.length === 0) return;
    const update = await this.git(['update-index', '--add', '--remove', '-z', '--stdin'], { input: files.stdout });
    if (update.code !== 0) throw new SnapshotError(gitFailureReason(update));
  }

  private async git(args: string[], o: { input?: string | Buffer; readOnly?: boolean; cwd?: string; raw?: boolean } = {}): Promise<GitResult> {
    const full = o.raw ? args : [`--git-dir=${this.storePath}`, `--work-tree=${this.vaultPath}`, ...args];
    try {
      return await this.opts.git.run(full, { cwd: o.cwd ?? this.vaultPath, input: o.input, readOnly: o.readOnly, store: this.storePath });
    } catch (err) {
      if (err instanceof GitSpawnError) throw new SnapshotError(err.message);
      throw err;
    }
  }
}

/** Parses `git diff --name-status -z --no-renames <snapshot>` (snapshot → vault now). */
export function parseNameStatus(out: Buffer): ChangedFile[] {
  const parts = out.toString('utf8').split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i] ?? '';
    const file = parts[i + 1] ?? '';
    if (!code || !file) continue;
    const status = code[0] === 'A' ? 'created' : code[0] === 'D' ? 'deleted' : 'modified';
    files.push({ path: file, status });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
