// Restore test helpers: a filesystem-backed Vault that behaves like Obsidian's (NFC index over the real — possibly NFD
// — names on disk, dot-folders not indexed, createBinary without parent folders fails, local trash = `.trash/<name>`),
// a real-git snapshot service over a temp vault, and fakes for the snapshots / sessions services.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, basename as pathBasename, join } from 'node:path';
import type { Vault } from 'obsidian';
import { vi } from 'vitest';
import type { ProfileId } from '../../src/core/constants';
import { PROFILE_LABELS } from '../../src/core/constants';
import type { SessionHandle, SessionsService } from '../../src/session/types';
import { GitRunner } from '../../src/snapshot/git';
import { SnapshotService } from '../../src/snapshot/service';
import { SnapshotStore } from '../../src/snapshot/store';
import type { ChangedFile, SnapshotInfo, SnapshotMeta, SnapshotResult, SnapshotsService } from '../../src/snapshot/types';
import { Events, FileSystemAdapter, TFile, TFolder, type TAbstractFile } from '../mocks/obsidian';
import { REAL_GIT, tempDir, testLogger } from '../snapshot/helpers';

export { gitWrapper, makeVault, readFile, REAL_GIT, sleep, tempDir, testLogger, writeFile } from '../snapshot/helpers';

const nfc = (s: string): string => s.normalize('NFC');

/** Obsidian's FileSystemAdapter subset used by the restore (paths are vault paths; mapped to real names on disk). */
export class FsAdapter extends FileSystemAdapter {
  constructor(
    private readonly base: string,
    private readonly vault: FsVault,
  ) {
    super(base);
  }
  full(p: string): string {
    return join(this.base, this.vault.realPath(p));
  }
  async exists(p: string): Promise<boolean> {
    return existsSync(this.full(p));
  }
  async mkdir(p: string): Promise<void> {
    this.vault.calls.push(`mkdir:${p}`);
    mkdirSync(this.full(p), { recursive: true });
    this.vault.sync();
  }
  async writeBinary(p: string, data: ArrayBuffer): Promise<void> {
    this.vault.calls.push(`writeBinary:${p}`);
    this.vault.maybeFail(p);
    writeFileSync(this.full(p), Buffer.from(data)); // like Obsidian: no parent folders are created
    this.vault.sync();
  }
  async readBinary(p: string): Promise<ArrayBuffer> {
    const b = readFileSync(this.full(p));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  /** Like Obsidian: `.trash/<name><ext>`, then `<name> 2<ext>`, `<name> 3<ext>` … */
  async trashLocal(p: string): Promise<void> {
    this.vault.calls.push(`trashLocal:${p}`);
    const from = this.full(p);
    const trash = join(this.base, '.trash');
    mkdirSync(trash, { recursive: true });
    const ext = extname(from);
    const name = pathBasename(from, ext);
    let target = join(trash, name + ext);
    for (let i = 2; existsSync(target); i++) target = join(trash, `${name} ${i}${ext}`);
    renameSync(from, target);
    this.vault.sync();
  }
}

/**
 * A Vault over a real folder. Indexed paths are NFC (as in Obsidian) while `realPath` keeps the on-disk spelling;
 * names starting with "." are not indexed. `failOn` makes writes to those paths throw.
 */
export class FsVault extends Events {
  configDir = '.obsidian';
  readonly adapter: FsAdapter;
  readonly root: TFolder;
  /** Every vault / adapter write call, in order. */
  readonly calls: string[] = [];
  readonly failOn = new Set<string>();
  private readonly index = new Map<string, TAbstractFile>();
  private readonly real = new Map<string, string>();

  constructor(readonly basePath: string) {
    super();
    this.adapter = new FsAdapter(basePath, this);
    this.root = new TFolder('/');
    this.sync();
  }

  /** Re-reads the folder (keeps the same TFile / TFolder objects for paths that still exist). */
  sync(): void {
    const seen = new Set<string>();
    const walk = (relReal: string, relNfc: string, parent: TFolder): void => {
      parent.children = [];
      for (const name of readdirSync(join(this.basePath, relReal)).sort()) {
        if (name.startsWith('.')) continue;
        const real = relReal ? `${relReal}/${name}` : name;
        const vaultPath = relNfc ? `${relNfc}/${nfc(name)}` : nfc(name);
        const isDir = statSync(join(this.basePath, real)).isDirectory();
        let f = this.index.get(vaultPath);
        if (!f || (isDir ? !(f instanceof TFolder) : !(f instanceof TFile))) {
          f = isDir ? new TFolder(vaultPath) : new TFile(vaultPath);
          f.vault = this as never;
          this.index.set(vaultPath, f);
        }
        f.parent = parent;
        parent.children.push(f);
        this.real.set(vaultPath, real);
        seen.add(vaultPath);
        if (isDir) walk(real, vaultPath, f as TFolder);
      }
    };
    walk('', '', this.root);
    for (const p of [...this.index.keys()]) {
      if (!seen.has(p)) {
        this.index.delete(p);
        this.real.delete(p);
      }
    }
  }

  /** On-disk spelling of a vault path (longest known prefix, like Obsidian's adapter). */
  realPath(p: string): string {
    for (let prefix = p; prefix; prefix = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '') {
      const real = this.real.get(prefix);
      if (real !== undefined) return real + p.slice(prefix.length);
    }
    return p;
  }

  maybeFail(p: string): void {
    if (this.failOn.has(nfc(p))) throw new Error(`EACCES: permission denied, open '${p}'`);
  }

  getName(): string {
    return 'vault';
  }
  getRoot(): TFolder {
    return this.root;
  }
  getAbstractFileByPath(p: string): TAbstractFile | null {
    if (p === '/' || p === '') return this.root;
    return this.index.get(p) ?? null;
  }
  getFileByPath(p: string): TFile | null {
    const f = this.getAbstractFileByPath(p);
    return f instanceof TFile ? f : null;
  }
  getAllLoadedFiles(): TAbstractFile[] {
    return [this.root, ...this.index.values()];
  }
  getFiles(): TFile[] {
    return [...this.index.values()].filter((f): f is TFile => f instanceof TFile);
  }
  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === 'md');
  }
  async read(file: TFile): Promise<string> {
    return readFileSync(this.adapter.full(file.path), 'utf8');
  }
  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }
  async createBinary(p: string, data: ArrayBuffer): Promise<TFile> {
    const path = nfc(p);
    this.calls.push(`createBinary:${path}`);
    if (existsSync(this.adapter.full(path))) throw new Error('File already exists.');
    this.maybeFail(path);
    writeFileSync(this.adapter.full(path), Buffer.from(data));
    this.sync();
    const f = this.getFileByPath(path)!;
    this.trigger('create', f);
    return f;
  }
  async createFolder(p: string): Promise<TFolder> {
    const path = nfc(p);
    this.calls.push(`createFolder:${path}`);
    if (existsSync(this.adapter.full(path))) throw new Error('Folder already exists.');
    mkdirSync(this.adapter.full(path), { recursive: true });
    this.sync();
    return this.getAbstractFileByPath(path) as TFolder;
  }
  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    this.calls.push(`modifyBinary:${file.path}`);
    this.maybeFail(file.path);
    writeFileSync(this.adapter.full(file.path), Buffer.from(data));
    this.trigger('modify', file);
  }
  async trash(file: TAbstractFile, system: boolean): Promise<void> {
    this.calls.push(`trash:${file.path}:${system}`);
    if (system) throw new Error('tests never use the system trash');
    this.maybeFail(file.path);
    await this.adapter.trashLocal(file.path);
    this.trigger('delete', file);
  }

  /** Tracked notes on disk (vault path NFC → content), outside `.trash/`, `.obsidian/` (dot-folders included). */
  notes(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (rel: string): void => {
      for (const name of readdirSync(join(this.basePath, rel)).sort()) {
        const p = rel ? `${rel}/${name}` : name;
        if (p === '.trash' || p === '.obsidian') continue;
        if (statSync(join(this.basePath, p)).isDirectory()) walk(p);
        else if (/\.(md|canvas|base)$/.test(name)) out[nfc(p)] = readFileSync(join(this.basePath, p), 'utf8');
      }
    };
    walk('');
    return out;
  }

  /** Names in `.trash/` (NFC). */
  trashed(): string[] {
    const dir = join(this.basePath, '.trash');
    return existsSync(dir) ? readdirSync(dir).map(nfc).sort() : [];
  }

  asVault(): Vault {
    return this as unknown as Vault;
  }
}

/** A real-git snapshot service over `vault` (store in a temp dir under the test HOME). */
export function realSnapshots(vault: string, opts: { gitPath?: string; storePath?: string; turnedOn?: boolean } = {}) {
  const log = testLogger();
  const storePath = opts.storePath ?? join(tempDir('store-'), 'snap.git');
  const store = new SnapshotStore({ vaultPath: vault, git: new GitRunner(opts.gitPath ?? REAL_GIT), storePath, log });
  const service = new SnapshotService({
    store,
    isTurnedOn: () => opts.turnedOn ?? true,
    checkGit: async () => ({ ok: true, version: 'git version test' }),
    log,
  });
  return { service, store, storePath, log };
}

export function info(commit: string, over: Partial<SnapshotInfo> = {}): SnapshotInfo {
  return { commit, time: Date.UTC(2026, 9, 7, 5, 3), subject: `snapshot ${commit}`, kind: 'prompt', ...over };
}

/** In-memory snapshots service for UI tests; every call is a spy. */
export class FakeSnapshots implements SnapshotsService {
  storePath = '/store.git';
  available = true;
  reason: string | undefined;
  infos: SnapshotInfo[] = [];
  changes = new Map<string, ChangedFile[]>();
  /** When set, `changedSinceMany` waits for it. */
  gate: Promise<void> | null = null;
  countError: Error | null = null;
  listError: Error | null = null;
  readonly list = vi.fn(async (_o?: { limit?: number }): Promise<SnapshotInfo[]> => {
    if (this.listError) throw this.listError;
    return _o?.limit ? this.infos.slice(0, _o.limit) : [...this.infos];
  });
  readonly changedSinceMany = vi.fn(async (commits: readonly string[]): Promise<Map<string, ChangedFile[]>> => {
    if (this.gate) await this.gate;
    if (this.countError) throw this.countError;
    return new Map(commits.map((c) => [c, this.changes.get(c) ?? []]));
  });
  readonly changedSince = vi.fn(async (commit: string): Promise<ChangedFile[]> => [...(this.changes.get(commit) ?? [])]);
  readonly readFileAt = vi.fn(async (_c: string, p: string): Promise<Buffer> => Buffer.from(`content of ${p}`));
  readonly snapshotNow = vi.fn(async (_m: SnapshotMeta, _o?: { waitMs?: number }): Promise<SnapshotResult> => ({ status: 'committed', commit: 'f'.repeat(40) }));
  readonly requestSnapshot = vi.fn(async (): Promise<SnapshotResult> => ({ status: 'unchanged' }));
  readonly markChanged = vi.fn((_r?: string) => {});
  isEnabled(): boolean {
    return this.available;
  }
  isAvailable(): boolean {
    return this.available;
  }
  unavailableReason(): string | undefined {
    return this.reason;
  }
  hasChanges(): boolean {
    return false;
  }
  async whenIdle(): Promise<void> {}
}

export interface FakeSession extends SessionHandle {
  stopped: string[];
}

/** A session handle; `stop` resolves after `stopMs` (Infinity = never). */
export function fakeSession(profile: ProfileId, running: boolean, panelId = `${profile}-${Math.random().toString(36).slice(2, 8)}`): FakeSession {
  return {
    panelId,
    profile,
    sessionId: undefined,
    state: running ? 'running' : 'exited',
    terminal: undefined,
    label: PROFILE_LABELS[profile],
    isRunning: running,
    pid: undefined,
    attached: true,
    startedAt: undefined,
    stopped: [],
    sendInput: () => {},
    print: () => {},
    holdInput: () => () => {},
    clear: () => {},
  };
}

/** A `sessions` service with the given handles; `stop` records the reason and waits `stopMs`. */
export function fakeSessions(handles: FakeSession[], stopMs = 0) {
  const order: string[] = [];
  const stop = vi.fn((panelId: string, reason: string): Promise<void> => {
    const h = handles.find((s) => s.panelId === panelId);
    h?.stopped.push(reason);
    order.push(`stop:${panelId}`);
    if (!Number.isFinite(stopMs)) return new Promise<void>(() => {});
    return new Promise<void>((r) => setTimeout(r, stopMs));
  });
  const service = { get: (id: string) => handles.find((s) => s.panelId === id), list: () => [...handles], stop } as unknown as SessionsService;
  return { service, stop, order };
}
