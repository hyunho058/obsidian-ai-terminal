import { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitRunner, runningLockingGit } from '../../src/snapshot/git';
import { ChangeFlag, SerialQueue, waitAtMost } from '../../src/snapshot/queue';
import { SnapshotService } from '../../src/snapshot/service';
import { commitCount, gitWrapper, makeVault, newStore, REAL_GIT, sleep, tempDir, testLogger, writeFile, type WrapperOptions } from './helpers';

const gitOk = async () => ({ ok: true as const, version: 'git version test' });

function makeService(vault: string, opts: { git?: string; turnedOn?: () => boolean; onNested?: (d: string[]) => void } = {}) {
  const log = testLogger();
  const store = newStore(vault, opts.git ?? REAL_GIT, log);
  const service = new SnapshotService({
    store,
    isTurnedOn: opts.turnedOn ?? (() => true),
    checkGit: gitOk,
    log,
    onNestedRepositories: opts.onNested,
  });
  return { service, store, log };
}

function loggingGit(extra: Omit<WrapperOptions, 'logTo'> = {}) {
  const logFile = join(tempDir('gitlog-'), 'calls.log');
  writeFileSync(logFile, '');
  const git = gitWrapper({ ...extra, logTo: logFile });
  return { git, calls: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SerialQueue / waitAtMost / ChangeFlag', () => {
  it('runs jobs one at a time, in order, and survives failures', async () => {
    const q = new SerialQueue();
    const events: string[] = [];
    let running = 0;
    const job = (name: string, ms: number, fail = false) => async () => {
      running++;
      expect(running).toBe(1);
      events.push(`start ${name}`);
      await sleep(ms);
      events.push(`end ${name}`);
      running--;
      if (fail) throw new Error(name);
      return name;
    };
    const a = q.run(job('a', 30));
    const b = q.run(job('b', 5, true));
    const c = q.run(job('c', 5));
    expect(q.size).toBe(3);
    await expect(a).resolves.toBe('a');
    await expect(b).rejects.toThrow('b');
    await expect(c).resolves.toBe('c');
    await q.whenIdle();
    expect(q.size).toBe(0);
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('waitAtMost stops waiting without stopping the work', async () => {
    let finished = false;
    const work = sleep(80).then(() => {
      finished = true;
      return 7;
    });
    expect(await waitAtMost(work, 10)).toEqual({ done: false });
    expect(finished).toBe(false);
    expect(await waitAtMost(work, Infinity)).toEqual({ done: true, value: 7 });
    expect(finished).toBe(true);
  });

  it('ChangeFlag', () => {
    const f = new ChangeFlag();
    expect(f.isSet()).toBe(false);
    f.set('load');
    expect([f.isSet(), f.reason]).toEqual([true, 'load']);
    f.clear();
    expect([f.isSet(), f.reason]).toEqual([false, undefined]);
  });
});

describe('SnapshotService (real git)', () => {
  it('disabled when snapshots are off or git is unavailable', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const off = makeService(vault, { turnedOn: () => false });
    off.service.markChanged();
    expect(await off.service.requestSnapshot({ kind: 'prompt', ai: 'claude' }, { waitMs: 1000 })).toEqual({ status: 'disabled' });
    expect(off.service.isEnabled()).toBe(false);

    const store = newStore(vault);
    const noGit = new SnapshotService({ store, isTurnedOn: () => true, checkGit: async () => ({ ok: false, reason: 'no CLT' }), log: testLogger() });
    noGit.markChanged();
    expect(await noGit.requestSnapshot({ kind: 'prompt' }, { waitMs: 10 })).toEqual({ status: 'disabled' });
    expect(await noGit.snapshotNow({ kind: 'restore' })).toEqual({ status: 'disabled', reason: 'no CLT' });
    expect([noGit.isAvailable(), noGit.unavailableReason()]).toEqual([false, 'no CLT']);
    await expect(noGit.list()).rejects.toThrow('no CLT');
    expect(store.exists()).toBe(false);
  });

  it('flag: a request runs git only when the flag is set; the flag clears when the snapshot starts', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const { git, calls } = loggingGit();
    const { service } = makeService(vault, { git });
    expect(service.hasChanges()).toBe(false);
    expect(await service.requestSnapshot({ kind: 'prompt', ai: 'claude' }, { waitMs: 5000 })).toEqual({ status: 'unchanged' });
    expect(calls()).toEqual([]);

    service.markChanged('test');
    const r = await service.requestSnapshot({ kind: 'prompt', ai: 'claude', prompt: 'p' }, { waitMs: 5000 });
    expect(r.status).toBe('committed');
    expect(service.hasChanges()).toBe(false);
    expect(calls()).toContain('commit');
    const n = calls().length;
    // Flag clear → no git at all, the last commit is reported.
    expect(await service.requestSnapshot({ kind: 'prompt', ai: 'claude' }, { waitMs: 5000 })).toEqual({ status: 'unchanged', commit: r.commit });
    expect(calls()).toHaveLength(n);
    // Flag set, no real change → git runs, no new commit (R12.5).
    service.markChanged();
    expect((await service.requestSnapshot({ kind: 'prompt', ai: 'agy' }, { waitMs: 5000 })).status).toBe('unchanged');
    expect(calls().length).toBeGreaterThan(n);
  });

  it('R12.9: a slow commit returns "pending" after waitMs, git is not killed, and the commit appears later', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const { service, store } = makeService(vault, { git: gitWrapper({ sleepOn: { commands: ['commit'], seconds: 1.2 } }) });
    const kill = vi.spyOn(ChildProcess.prototype, 'kill');
    service.markChanged();
    const started = Date.now();
    const r = await service.requestSnapshot({ kind: 'prompt', ai: 'claude', prompt: 'slow one' }, { waitMs: 300 });
    expect(r).toEqual({ status: 'pending' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(service.hasChanges()).toBe(false); // cleared when the snapshot started
    expect(runningLockingGit(store.storePath)).toBe(1);
    // A second request while it runs (flag clear) waits for the same snapshot.
    expect(await service.requestSnapshot({ kind: 'prompt', ai: 'claude' }, { waitMs: 50 })).toEqual({ status: 'pending' });
    const late = await service.requestSnapshot({ kind: 'prompt', ai: 'claude' }, { waitMs: 5000 });
    expect(late.status).toBe('committed');
    await service.whenIdle();
    expect(kill).not.toHaveBeenCalled();
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.subject).toMatch(/^Before Claude Code: "slow one" — /);
    expect(runningLockingGit(store.storePath)).toBe(0);
  });

  it('R12.10: a git error is reported with its reason, the flag stays set, and the next attempt succeeds', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const marker = join(tempDir('fail-'), 'fail');
    const wrapper = gitWrapper({});
    // Fail update-index only while the marker exists.
    writeFileSync(
      wrapper,
      readFileSync(wrapper, 'utf8').replace(
        /^exec /m,
        `if [ "$sub" = update-index ] && [ -e '${marker}' ]; then echo 'fatal: simulated disk failure' >&2; exit 128; fi\nexec `,
      ),
    );
    writeFileSync(marker, '');
    const { service } = makeService(vault, { git: wrapper });
    service.markChanged();
    expect(await service.requestSnapshot({ kind: 'prompt', ai: 'claude' }, { waitMs: 5000 })).toEqual({ status: 'failed', reason: 'simulated disk failure' });
    expect(service.hasChanges()).toBe(true);
    rmSync(marker);
    expect((await service.requestSnapshot({ kind: 'prompt', ai: 'claude' }, { waitMs: 5000 })).status).toBe('committed');
  });

  it('R12.11: a stale index.lock is removed when no plugin git runs, and left alone while one does', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const { service, store } = makeService(vault);
    expect((await service.snapshotNow({ kind: 'first' })).status).toBe('committed');
    const lock = join(store.storePath, 'index.lock');

    writeFileSync(lock, '');
    writeFile(vault, 'a.md', 'A2');
    service.markChanged();
    expect((await service.requestSnapshot({ kind: 'prompt', ai: 'agy' }, { waitMs: 5000 })).status).toBe('committed');
    expect(existsSync(lock)).toBe(false);

    // A git started by "another plugin instance" (same window, e.g. before a reload) still runs in the store.
    writeFileSync(lock, '');
    const slow = new GitRunner(gitWrapper({ sleepOn: { commands: ['status'], seconds: 0.8 } }));
    const running = slow.run([`--git-dir=${store.storePath}`, `--work-tree=${vault}`, 'status'], { cwd: vault, store: store.storePath });
    await sleep(100);
    expect(await store.clearStaleLocks()).toBe(false);
    expect(existsSync(lock)).toBe(true);
    writeFile(vault, 'a.md', 'A3');
    const r = await service.snapshotNow({ kind: 'restore' }); // waits for that git, then cleans up
    await running;
    expect(r.status).toBe('committed');
    expect(existsSync(lock)).toBe(false);
  });

  it('R12.17: concurrent requests run one after another without index.lock errors', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const { git, calls } = loggingGit({ sleepOn: { commands: ['update-index'], seconds: 0.2 } });
    const { service, store } = makeService(vault, { git });
    service.markChanged('plugin load');
    // Two panels restored at startup request a snapshot at the same time.
    const [one, two] = await Promise.all([
      service.requestSnapshot({ kind: 'spawn', ai: 'claude', panelId: 'p1' }, { waitMs: 10_000 }),
      service.requestSnapshot({ kind: 'spawn', ai: 'agy', panelId: 'p2' }, { waitMs: 10_000 }),
    ]);
    // The second job starts after the first cleared the flag: it is covered by the same commit.
    expect(one.status).toBe('committed');
    expect(two).toEqual({ status: 'unchanged', commit: one.commit });
    expect(commitCount(store.storePath, vault)).toBe(1);

    // Forced snapshots with changes in between commit in order.
    const results = await Promise.all(
      [1, 2, 3].map((i) => {
        writeFile(vault, `n${i}.md`, String(i));
        return service.snapshotNow({ kind: 'restore', label: `Restore ${i}` });
      }),
    );
    expect(results.map((r) => r.status)).not.toContain('failed');
    expect(commitCount(store.storePath, vault)).toBeGreaterThanOrEqual(2);
    // Never two git commands at once: each update-index is followed by its own diff before the next job starts.
    const seq = calls().filter((c) => ['update-index', 'diff', 'commit'].includes(c));
    for (let i = 0; i < seq.length; i++) if (seq[i] === 'update-index') expect(seq[i + 1]).toBe('diff');
  });

  it('changedSince goes through the queue and leaves the flag alone', async () => {
    const vault = makeVault({ 'a.md': 'A', 'b.md': 'B' });
    const { service } = makeService(vault);
    const first = await service.snapshotNow({ kind: 'first' });
    writeFile(vault, 'a.md', 'changed');
    service.markChanged();
    expect(await service.changedSince(first.commit!)).toEqual([{ path: 'a.md', status: 'modified' }]);
    expect(service.hasChanges()).toBe(true);
    expect((await service.readFileAt(first.commit!, 'a.md')).toString()).toBe('A');
    const many = await service.changedSinceMany([first.commit!]);
    expect([...many.keys()]).toEqual([first.commit]);
  });

  it('R12.14: nested repositories are reported once per Obsidian session', async () => {
    const vault = makeVault({ 'a.md': 'A', 'repo/n.md': 'n' });
    const { execFileSync } = await import('node:child_process');
    execFileSync(REAL_GIT, ['init', '-q'], { cwd: join(vault, 'repo') });
    const seen: string[][] = [];
    const a = makeService(vault, { onNested: (d) => seen.push(d) });
    a.service.markChanged();
    await a.service.requestSnapshot({ kind: 'prompt', ai: 'agy' }, { waitMs: 5000 });
    await sleep(300);
    writeFile(vault, 'a.md', 'A2');
    a.service.markChanged();
    await a.service.requestSnapshot({ kind: 'prompt', ai: 'agy' }, { waitMs: 5000 });
    // A reloaded plugin (new service, same store) in the same window does not repeat it.
    const b = makeService(vault, { onNested: (d) => seen.push(d) });
    b.service.markChanged();
    await b.service.requestSnapshot({ kind: 'prompt', ai: 'agy' }, { waitMs: 5000 });
    await sleep(300);
    expect(seen).toEqual([['repo']]);
  });

  it('after dispose, queued jobs are skipped', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const { service } = makeService(vault, { git: gitWrapper({ sleepOn: { commands: ['commit'], seconds: 0.3 } }) });
    service.markChanged();
    const first = service.snapshotNow({ kind: 'first' });
    await sleep(50);
    const queued = service.snapshotNow({ kind: 'restore' });
    await sleep(10);
    service.dispose();
    expect((await first).status).toBe('committed');
    expect(await queued).toEqual({ status: 'disabled' });
  });
});
