import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkGit, GitRunner, gitEnv, gitFailureReason, SAFE_GIT_CONFIG } from '../../src/snapshot/git';
import { parseNameStatus, SnapshotError, snapshotPathspecs, storePathFor } from '../../src/snapshot/store';
import { commitCount, makeVault, newStore, REAL_GIT, readFile, storeGit, tempDir, writeFile } from './helpers';

const NFC = '한글 노트.md';
const NFD = NFC.normalize('NFD');

describe('snapshot store (real git)', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  it('R12.2: store lives under ~/.local/share/obsidian-ai-terminal/snapshots/<sha256[:16]>.git, records the vault, no .git in the vault', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const store = newStore(vault);
    const hash = createHash('sha256').update(vault).digest('hex').slice(0, 16);
    expect(store.storePath).toBe(join(homedir(), '.local', 'share', 'obsidian-ai-terminal', 'snapshots', `${hash}.git`));
    expect(storePathFor(vault)).toBe(store.storePath);
    const r = await store.snapshot({ kind: 'first' });
    expect(r.status).toBe('committed');
    expect(existsSync(join(store.storePath, 'HEAD'))).toBe(true);
    expect(existsSync(join(vault, '.git'))).toBe(false);
    expect(statSync(dirname(store.storePath)).mode & 0o777).toBe(0o700);
    expect(statSync(join(homedir(), '.local', 'share', 'obsidian-ai-terminal')).mode & 0o777).toBe(0o700);
    const cfg = (key: string) => storeGit(store.storePath, vault, ['config', '--get', key]).trim();
    expect(cfg('obsidian-ai-terminal.vaultpath')).toBe(vault);
    expect(cfg('core.untrackedCache')).toBe('true');
    expect(cfg('core.precomposeunicode')).toBe('true');
    // Nothing else was written inside the vault.
    expect(readFile(vault, 'a.md')).toBe('A');
  });

  it('R12.12: tracks .md/.canvas/.base even when the vault .gitignore ignores them; skips .obsidian, .trash, attachments', async () => {
    const vault = makeVault({
      '.gitignore': '*.md\n*.canvas\n',
      'note.md': 'n',
      'deep/er/sub.md': 's',
      'board.canvas': '{}',
      'table.base': 'b',
      '.obsidian/app.json': '{}',
      '.obsidian/snippets/x.md': 'x',
      '.trash/old.md': 'o',
      'img.png': 'png',
      'attachments/doc.pdf': 'pdf',
      'deep/.gitignore': '*\n',
      'deep/ignored.md': 'still tracked',
    });
    const store = newStore(vault);
    await store.snapshot({ kind: 'first' });
    const files = storeGit(store.storePath, vault, ['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n').sort();
    expect(files).toEqual(['board.canvas', 'deep/er/sub.md', 'deep/ignored.md', 'note.md', 'table.base']);
  });

  it("a custom config folder is excluded too", () => {
    expect(snapshotPathspecs('.config-obsidian')).toEqual([
      '*.md',
      '*.canvas',
      '*.base',
      ':(exclude).obsidian/**',
      ':(exclude).trash/**',
      ':(exclude).config-obsidian/**',
    ]);
  });

  it('R12.13: own identity; the user git config (gpgsign, hooksPath, identity env) neither applies nor changes', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const hooks = tempDir('hooks-');
    const marker = join(hooks, 'hook-ran');
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(hooks, 'commit-msg'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const userConfig = `[user]\n\tname = Real User\n\temail = real@example.com\n[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${hooks}\n\tfsmonitor = true\n[gpg]\n\tprogram = /nonexistent/gpg\n`;
    const globalFile = join(tempDir('gcfg-'), 'gitconfig');
    writeFileSync(globalFile, userConfig);
    writeFileSync(join(homedir(), '.gitconfig'), userConfig);
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    process.env.GIT_AUTHOR_NAME = 'Env Person';
    process.env.GIT_COMMITTER_EMAIL = 'env@example.com';
    process.env.GIT_INDEX_FILE = join(vault, 'evil-index');

    const store = newStore(vault);
    expect((await store.snapshot({ kind: 'prompt', ai: 'claude', prompt: 'hi' })).status).toBe('committed');
    const ident = storeGit(store.storePath, vault, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%G?']).trim();
    expect(ident).toBe('Obsidian AI Terminal <noreply@localhost>|Obsidian AI Terminal <noreply@localhost>|N');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(vault, 'evil-index'))).toBe(false);
    expect(readFileSync(globalFile, 'utf8')).toBe(userConfig);
    expect(readFileSync(join(homedir(), '.gitconfig'), 'utf8')).toBe(userConfig);
    rmSync(join(homedir(), '.gitconfig'));
  });

  it('git environment: GIT_* overrides dropped, user/system config ignored, every command gets the safe -c config', () => {
    const env = gitEnv({ PATH: '/bin', GIT_DIR: '/x', GIT_WORK_TREE: '/y', GIT_AUTHOR_NAME: 'n', HOME: '/h' }, true);
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    });
    expect(gitEnv({}, false).GIT_OPTIONAL_LOCKS).toBeUndefined();
    expect(SAFE_GIT_CONFIG).toEqual(
      expect.arrayContaining([
        'commit.gpgsign=false',
        'core.hooksPath=/dev/null',
        'core.autocrlf=false',
        'core.precomposeunicode=true',
        'core.quotepath=false',
        'user.name=Obsidian AI Terminal',
        'user.email=noreply@localhost',
      ]),
    );
  });

  it('R12.5: nothing changed → no new commit', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const store = newStore(vault);
    const first = await store.snapshot({ kind: 'first' });
    const again = await store.snapshot({ kind: 'prompt', ai: 'claude', prompt: 'x' });
    expect(again).toEqual({ status: 'unchanged', commit: first.commit });
    writeFile(vault, 'img.png', 'only an attachment changed');
    expect((await store.snapshot({ kind: 'prompt', ai: 'agy' })).status).toBe('unchanged');
    expect(commitCount(store.storePath, vault)).toBe(1);
    writeFile(vault, 'a.md', 'A2');
    expect((await store.snapshot({ kind: 'prompt', ai: 'agy' })).status).toBe('committed');
    expect(commitCount(store.storePath, vault)).toBe(2);
  });

  it('an empty vault gives "unchanged" and no commit', async () => {
    const vault = makeVault({ 'img.png': 'x' });
    const store = newStore(vault);
    expect(await store.snapshot({ kind: 'first' })).toEqual({ status: 'unchanged' });
    expect(await store.list()).toEqual([]);
  });

  it('Korean NFD / NFC file names: stored once as NFC, no phantom changes, readable by either form', async () => {
    const vault = makeVault();
    writeFile(vault, NFD, 'decomposed name');
    writeFile(vault, '폴더/정리.md'.normalize('NFD'), 'nested');
    const store = newStore(vault);
    const r = await store.snapshot({ kind: 'first' });
    const files = storeGit(store.storePath, vault, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean);
    expect(files.sort()).toEqual(['폴더/정리.md', NFC].sort());
    expect((await store.snapshot({ kind: 'prompt', ai: 'agy' })).status).toBe('unchanged');
    expect((await store.changedSince([r.commit!])).get(r.commit!)).toEqual([]);
    expect((await store.readFileAt(r.commit!, NFC)).toString()).toBe('decomposed name');
    expect((await store.readFileAt(r.commit!, NFD)).toString()).toBe('decomposed name');
  });

  it('list (newest first, structured), changedSince (modified / deleted / created), readFileAt', async () => {
    const vault = makeVault({ 'A.md': 'a1', 'B.md': 'b1', 'keep.md': 'k', 'sub/D.canvas': '{"d":1}' });
    const store = newStore(vault);
    const t1 = new Date(2026, 9, 7, 9, 5);
    const s1 = await store.snapshot({ kind: 'prompt', ai: 'claude', panelId: 'panel-1', prompt: 'make this shorter' }, t1);
    writeFile(vault, 'A.md', 'a2');
    rmSync(join(vault, 'B.md'));
    writeFile(vault, 'C.md', 'new');
    writeFile(vault, 'sub/D.canvas', '{"d":2}');
    const s2 = await store.snapshot({ kind: 'prompt', ai: 'agy', panelId: 'panel-2' }, new Date(2026, 9, 7, 9, 6));
    writeFile(vault, 'A.md', 'a3');

    const list = await store.list();
    expect(list.map((s) => s.commit)).toEqual([s2.commit, s1.commit]);
    expect(list[1]).toMatchObject({
      commit: s1.commit,
      subject: 'Before Claude Code: "make this shorter" — 2026-10-07 09:05',
      kind: 'prompt',
      ai: 'claude',
      panelId: 'panel-1',
      promptExcerpt: 'make this shorter',
    });
    expect(list[0]).toMatchObject({ subject: 'Before input in Antigravity — 2026-10-07 09:06', ai: 'agy', kind: 'prompt', panelId: 'panel-2' });
    expect(list[0]!.promptExcerpt).toBeUndefined();
    expect(Math.abs(list[0]!.time - Date.now())).toBeLessThan(60_000);
    expect(await store.list(1)).toHaveLength(1);

    const changes = await store.changedSince([s1.commit!, s2.commit!]);
    expect(changes.get(s1.commit!)).toEqual([
      { path: 'A.md', status: 'modified' },
      { path: 'B.md', status: 'deleted' },
      { path: 'C.md', status: 'created' },
      { path: 'sub/D.canvas', status: 'modified' },
    ]);
    expect(changes.get(s2.commit!)).toEqual([{ path: 'A.md', status: 'modified' }]);
    // changedSince never commits.
    expect(commitCount(store.storePath, vault)).toBe(2);

    expect((await store.readFileAt(s1.commit!, 'B.md')).toString()).toBe('b1');
    expect((await store.readFileAt(s1.commit!, 'A.md')).toString()).toBe('a1');
    await expect(store.readFileAt(s1.commit!, 'C.md')).rejects.toThrow(SnapshotError);
    await expect(store.readFileAt('--output=/tmp/x', 'A.md')).rejects.toThrow(/not a snapshot id/);
    await expect(store.changedSince(['HEAD'])).rejects.toThrow(/not a snapshot id/);
  });

  it('R12.14: nested repositories are listed (root .git and ordinary folders are not)', async () => {
    const vault = makeVault({ 'a.md': 'A', 'plain/x.md': 'x', 'repo/n.md': 'n', 'deep/inner/r.md': 'r' });
    const run = (cwd: string) => storeGit(join(cwd, '.git'), cwd, ['init', '-q']);
    mkdirSync(join(vault, 'repo', '.git'));
    run(join(vault, 'repo'));
    run(join(vault, 'deep', 'inner'));
    run(vault); // the user's own repository at the vault root is left alone
    const store = newStore(vault);
    await store.snapshot({ kind: 'first' });
    expect(await store.nestedRepositories()).toEqual(['deep/inner', 'repo']);
    const files = storeGit(store.storePath, vault, ['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n');
    expect(files.sort()).toEqual(['a.md', 'plain/x.md']);
    expect(existsSync(join(vault, '.git', 'index'))).toBe(false);
  });

  it('a store recorded for another vault is refused', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const store = newStore(vault);
    await store.snapshot({ kind: 'first' });
    const moved = `${vault}-moved`;
    renameSync(vault, moved);
    const other = new (store.constructor as typeof import('../../src/snapshot/store').SnapshotStore)({ vaultPath: moved, git: new GitRunner(REAL_GIT), storePath: store.storePath });
    await expect(other.snapshot({ kind: 'first' })).rejects.toThrow(/belongs to another vault/);
  });

  it('a missing vault folder is a readable failure', async () => {
    const vault = makeVault({ 'a.md': 'A' });
    const store = newStore(vault);
    rmSync(vault, { recursive: true });
    await expect(store.snapshot({ kind: 'first' })).rejects.toThrow(/is not accessible/);
  });

  it('parseNameStatus and gitFailureReason', () => {
    expect(parseNameStatus(Buffer.from('M\0a.md\0D\0b.md\0A\0c d.md\0T\0e.md\0'))).toEqual([
      { path: 'a.md', status: 'modified' },
      { path: 'b.md', status: 'deleted' },
      { path: 'c d.md', status: 'created' },
      { path: 'e.md', status: 'modified' },
    ]);
    expect(
      gitFailureReason({
        code: 128,
        signal: null,
        stderr: "fatal: Unable to create '/s/index.lock': File exists.\n\nAnother git process seems to be running\n",
      }),
    ).toBe("Unable to create '/s/index.lock': File exists.");
    expect(gitFailureReason({ code: 1, signal: null, stderr: '' })).toBe('git exited with code 1');
  });

  it('R12.16: checkGit reports a missing git; the system git works here', async () => {
    const missing = await checkGit('/nonexistent/bin/git');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('/nonexistent/bin/git');
    const broken = join(tempDir('badgit-'), 'git');
    writeFileSync(broken, '#!/bin/sh\necho nope >&2\nexit 3\n', { mode: 0o755 });
    expect((await checkGit(broken)).ok).toBe(false);
    if (existsSync('/Library/Developer/CommandLineTools') || existsSync('/Applications/Xcode.app')) {
      const sys = await checkGit();
      expect(sys).toMatchObject({ ok: true });
    }
  });
});
