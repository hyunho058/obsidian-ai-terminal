import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IDE_NAME,
  cleanStaleLockFiles,
  ideLockDir,
  isPidAlive,
  removeLockFile,
  workspaceFoldersFor,
  writeLockFile,
  type IdeLockContent,
} from '../../src/bridge/lockFile';

const dir = (): string => join(mkdtempSync(join(tmpdir(), 'ide-lock-')), 'ide');

function lock(over: Partial<IdeLockContent> = {}): IdeLockContent {
  return { pid: process.pid, workspaceFolders: ['/vault'], ideName: IDE_NAME, transport: 'ws', authToken: 'token-123456', ...over };
}

describe('lock file location', () => {
  it('is ~/.claude/ide (Claude scans it even when CLAUDE_CONFIG_DIR is set)', () => {
    expect(ideLockDir()).toBe(join(homedir(), '.claude', 'ide'));
  });

  it('workspaceFolders = [vaultPath] (+ its real path when it differs)', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'vault-')));
    expect(workspaceFoldersFor(real)).toEqual([real]);
    const link = join(tmpdir(), `vault-link-${Date.now()}`);
    symlinkSync(real, link);
    expect(workspaceFoldersFor(link)).toEqual([link, real]);
    expect(workspaceFoldersFor('/does/not/exist')).toEqual(['/does/not/exist']);
  });
});

describe('writeLockFile (R10.1)', () => {
  it('writes <port>.lock with mode 0600 and the exact fields, in a 0700 folder created on demand', () => {
    const d = dir();
    const file = writeLockFile(d, 4321, lock());
    expect(file).toBe(join(d, '4321.lock'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      pid: process.pid,
      workspaceFolders: ['/vault'],
      ideName: 'Obsidian',
      transport: 'ws',
      authToken: 'token-123456',
    });
    expect(readdirSync(d)).toEqual(['4321.lock']); // no temp file left behind
  });

  it('replaces an existing file atomically and keeps 0600', () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '4321.lock'), 'old', { mode: 0o644 });
    const file = writeLockFile(d, 4321, lock({ authToken: 'new-token-1' }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).authToken).toBe('new-token-1');
    expect(readdirSync(d)).toEqual(['4321.lock']);
  });
});

describe('removeLockFile (R10.9)', () => {
  it('removes our file synchronously, and only if the token still matches', () => {
    const d = dir();
    const file = writeLockFile(d, 1111, lock());
    expect(removeLockFile(file, 'someone-else')).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(removeLockFile(file, 'token-123456')).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(removeLockFile(file, 'token-123456')).toBe(false); // already gone: no throw
  });
});

describe('isPidAlive', () => {
  it('is true for this process, false for a dead pid and for invalid pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999_999)).toBe(false);
    expect(isPidAlive(0)).toBe(false); // never process.kill(0, …) — that signals the process group
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

describe('cleanStaleLockFiles (D29, R10.7)', () => {
  it('deletes only Obsidian files with a dead pid; other IDEs, live pids and garbage are kept', async () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    const files: Record<string, string> = {
      'obsidian-dead.lock': JSON.stringify(lock({ pid: 900001 })),
      'obsidian-alive.lock': JSON.stringify(lock({ pid: 900002 })),
      'vscode-dead.lock': JSON.stringify({ pid: 900001, workspaceFolders: ['/x'], ideName: 'Visual Studio Code', transport: 'ws', authToken: 'a' }),
      'no-ide-name-dead.lock': JSON.stringify({ pid: 900001, workspaceFolders: ['/x'] }),
      'garbage.lock': '{not json',
      'plain-lines.lock': '/some/folder\n/other',
      'array.lock': JSON.stringify([1, 2]),
      'obsidian-pid-string.lock': JSON.stringify(lock({ pid: '900001' as unknown as number })),
      'obsidian-pid-zero.lock': JSON.stringify(lock({ pid: 0 })),
      'obsidian-dead.txt': JSON.stringify(lock({ pid: 900001 })),
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);
    mkdirSync(join(d, 'folder.lock'));
    symlinkSync(join(d, 'obsidian-dead.lock'), join(d, 'link-to-dead.lock'));
    const before = Object.fromEntries(Object.keys(files).map((n) => [n, readFileSync(join(d, n), 'utf8')]));

    const alive = new Set([900002]);
    const result = await cleanStaleLockFiles(d, (pid) => alive.has(pid));

    expect(result.removed).toEqual([join(d, 'obsidian-dead.lock')]);
    expect(existsSync(join(d, 'obsidian-dead.lock'))).toBe(false);
    for (const name of Object.keys(files)) {
      if (name === 'obsidian-dead.lock') continue;
      expect(readFileSync(join(d, name), 'utf8')).toBe(before[name]);
    }
    expect(existsSync(join(d, 'folder.lock'))).toBe(true);
    expect(result.kept).toContain(join(d, 'link-to-dead.lock'));
  });

  it('uses the real liveness check by default and ignores a missing folder', async () => {
    const d = dir();
    expect(await cleanStaleLockFiles(d)).toEqual({ removed: [], kept: [] });
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '1.lock'), JSON.stringify(lock({ pid: process.pid })));
    writeFileSync(join(d, '2.lock'), JSON.stringify(lock({ pid: 999_999 })));
    const result = await cleanStaleLockFiles(d);
    expect(result.removed).toEqual([join(d, '2.lock')]);
    expect(existsSync(join(d, '1.lock'))).toBe(true);
  });
});
