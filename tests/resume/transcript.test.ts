import { chmodSync, mkdirSync, openSync, rmSync, symlinkSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TRANSCRIPT_MAX_LINE_BYTES,
  canonicalPath,
  claudeConfigDir,
  findTranscriptFiles,
  isSameOrInside,
  lookupClaudeTranscript,
  scanTranscript,
} from '../../src/session/resumeTranscript';
import { claudeHome, conversation, entry, metaLines, resetClaudeHome, tempDir, writeTranscript } from './fixtures';

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
beforeAll(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterAll(() => {
  if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});
beforeEach(() => resetClaudeHome());

const lookup = (id: string, vault: string) => lookupClaudeTranscript(id, vault, { configDir: claudeHome() });

describe('claudeConfigDir', () => {
  it('is ~/.claude by default (temp HOME in tests)', () => {
    expect(claudeConfigDir({})).toBe(join(homedir(), '.claude'));
    expect(claudeConfigDir(undefined)).toBe(join(homedir(), '.claude'));
  });

  it('follows an absolute CLAUDE_CONFIG_DIR and ignores a relative one', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/cc' })).toBe('/tmp/cc');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'relative/dir' })).toBe(join(homedir(), '.claude'));
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' })).toBe(join(homedir(), '.claude'));
  });
});

describe('canonicalPath / isSameOrInside', () => {
  it('resolves symlinks, NFC-normalizes and drops a trailing slash', async () => {
    const base = await canonicalPath(tempDir());
    const real = join(base, 'real');
    mkdirSync(real);
    symlinkSync(real, join(base, 'link'));
    expect(await canonicalPath(join(base, 'link') + '/')).toBe(real);
    const nfd = join(base, '노트'.normalize('NFD'));
    mkdirSync(nfd);
    expect(await canonicalPath(join(base, '노트'.normalize('NFC')))).toBe(join(base, '노트').normalize('NFC'));
    expect(await canonicalPath(nfd)).toBe(join(base, '노트').normalize('NFC'));
  });

  it('keeps the missing tail of a deleted folder but still resolves its existing (symlinked) ancestors', async () => {
    const base = await canonicalPath(tempDir());
    const real = join(base, 'real');
    mkdirSync(real);
    symlinkSync(real, join(base, 'link'));
    expect(await canonicalPath(join(base, 'link', 'gone', 'deeper'))).toBe(join(real, 'gone', 'deeper'));
  });

  it('isSameOrInside compares whole path segments', () => {
    expect(isSameOrInside('/a/Notes', '/a/Notes')).toBe(true);
    expect(isSameOrInside('/a/Notes/Projects', '/a/Notes')).toBe(true);
    expect(isSameOrInside('/a/Notes-old', '/a/Notes')).toBe(false);
    expect(isSameOrInside('/a', '/a/Notes')).toBe(false);
    expect(isSameOrInside('/anything', '/')).toBe(true);
  });
});

describe('findTranscriptFiles', () => {
  it('checks every project folder without computing its name, and ignores non-files', async () => {
    const id = randomUUID();
    expect(await findTranscriptFiles(claudeHome(), id)).toEqual([]); // no projects folder at all
    const a = writeTranscript(id, [entry(id, '/x')], { folder: 'any name at all ~ with spaces' });
    const b = writeTranscript(id, [entry(id, '/y')], { folder: '-Users-someone-Notes' });
    writeTranscript(randomUUID(), [entry(id, '/z')], { folder: 'other' });
    mkdirSync(join(claudeHome(), 'projects', 'dir-not-file', `${id}.jsonl`), { recursive: true });
    writeFileSync(join(claudeHome(), 'projects', 'stray-file'), 'x');
    expect(await findTranscriptFiles(claudeHome(), id)).toEqual([a, b].sort());
  });
});

describe('lookupClaudeTranscript (D22)', () => {
  it('match: first recorded cwd is the vault (R5.4)', async () => {
    const vault = tempDir('vault-');
    const id = randomUUID();
    const file = conversation(id, vault);
    expect(await lookup(id, vault)).toEqual({ status: 'match', files: [file], firstCwd: vault, errors: [] });
  });

  it('match: first cwd is the vault, later entries are in a subfolder (R5.5)', async () => {
    const vault = tempDir('vault-');
    mkdirSync(join(vault, 'Projects'));
    const id = randomUUID();
    conversation(id, vault, [join(vault, 'Projects'), join(vault, 'Projects')]);
    expect((await lookup(id, vault)).status).toBe('match');
  });

  it('match: the first recorded cwd is already a subfolder of the vault', async () => {
    const vault = tempDir('vault-');
    const id = randomUUID();
    conversation(id, join(vault, 'Projects'));
    expect((await lookup(id, vault)).status).toBe('match');
  });

  it('match: any later cwd inside the vault also counts', async () => {
    const vault = tempDir('vault-');
    const id = randomUUID();
    conversation(id, '/somewhere/else', [join(vault, 'Daily')]);
    expect(await lookup(id, vault)).toMatchObject({ status: 'match', firstCwd: '/somewhere/else' });
  });

  it('elsewhere: every recorded cwd is outside the vault (R5.7), including a sibling with a common prefix', async () => {
    const parent = tempDir('parent-');
    const vault = join(parent, 'Notes');
    mkdirSync(vault);
    mkdirSync(join(parent, 'Notes-old'));
    const id = randomUUID();
    conversation(id, join(parent, 'Notes-old'), [parent]);
    expect(await lookup(id, vault)).toMatchObject({ status: 'elsewhere', firstCwd: join(parent, 'Notes-old') });
  });

  it('elsewhere: the vault was moved — the recorded folder no longer exists', async () => {
    const vault = tempDir('vault-');
    const id = randomUUID();
    conversation(id, join(tempDir('old-'), 'gone', 'OldVault'));
    expect((await lookup(id, vault)).status).toBe('elsewhere');
  });

  it('missing: no transcript file (R5.6)', async () => {
    const vault = tempDir('vault-');
    expect(await lookup(randomUUID(), vault)).toEqual({ status: 'missing', files: [], errors: [] });
    conversation(randomUUID(), vault); // another conversation does not count
    expect((await lookup(randomUUID(), vault)).status).toBe('missing');
  });

  it('symlinked vault: vault opened through a symlink, transcript records the real path — and vice versa', async () => {
    const base = tempDir('sym-');
    const real = join(base, 'Real Vault');
    mkdirSync(join(real, 'Sub'), { recursive: true });
    const link = join(base, 'Link Vault');
    symlinkSync(real, link);
    const a = randomUUID();
    conversation(a, real);
    expect((await lookup(a, link)).status).toBe('match');
    const b = randomUUID();
    conversation(b, join(link, 'Sub'));
    expect((await lookup(b, real)).status).toBe('match');
    const c = randomUUID();
    conversation(c, join(link, 'deleted-subfolder')); // not on disk any more; prefix still resolves
    expect((await lookup(c, real)).status).toBe('match');
  });

  it('Korean folder names: NFD on disk / in the transcript vs NFC vault path, and the reverse', async () => {
    const base = tempDir('ko-');
    const name = '내 노트';
    const onDisk = join(base, name.normalize('NFD'));
    mkdirSync(onDisk);
    const nfcPath = join(base, name.normalize('NFC'));
    const nfdPath = join(base, name.normalize('NFD'));
    expect(nfcPath).not.toBe(nfdPath);
    const a = randomUUID();
    conversation(a, nfdPath);
    expect((await lookup(a, nfcPath)).status).toBe('match');
    const b = randomUUID();
    conversation(b, nfcPath);
    expect((await lookup(b, nfdPath)).status).toBe('match');
    const c = randomUUID();
    conversation(c, join(nfdPath, '프로젝트'.normalize('NFD'))); // missing subfolder, NFD spelling
    expect((await lookup(c, nfcPath)).status).toBe('match');
  });

  it('skips malformed lines and non-object JSON before the first cwd', async () => {
    const vault = tempDir('vault-');
    const id = randomUUID();
    writeTranscript(id, ['{not json', '[1,2,3]', 'null', '"cwd"', '{"cwd": 42}', '{"cwd": ""}', ...metaLines(id), entry(id, vault)]);
    expect((await lookup(id, vault)).status).toBe('match');
  });

  it('empty: file exists but holds no recorded cwd (0 bytes, metadata only, all malformed)', async () => {
    const vault = tempDir('vault-');
    const a = randomUUID();
    writeTranscript(a, [], { trailingNewline: false });
    expect((await lookup(a, vault)).status).toBe('empty');
    const b = randomUUID();
    writeTranscript(b, metaLines(b));
    expect((await lookup(b, vault)).status).toBe('empty');
    const c = randomUUID();
    writeTranscript(c, ['{"cwd":', 'garbage', '{"type":"user","cwd":"/x"']);
    expect((await lookup(c, vault)).status).toBe('empty');
  });

  it('unreadable: a transcript that cannot be opened', async () => {
    if (process.getuid?.() === 0) return; // root can read anything
    const vault = tempDir('vault-');
    const id = randomUUID();
    const file = conversation(id, vault);
    chmodSync(file, 0o000);
    try {
      const found = await lookup(id, vault);
      expect(found.status).toBe('unreadable');
      expect(found.errors[0]).toContain(file);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it('several files for one id: a match in any of them wins', async () => {
    const vault = tempDir('vault-');
    const id = randomUUID();
    conversation(id, '/elsewhere', [], { folder: 'a-other' });
    conversation(id, vault, [], { folder: 'b-vault' });
    expect((await lookup(id, vault)).status).toBe('match');
  });

  it('reads the transcripts under a custom config folder ($CLAUDE_CONFIG_DIR)', async () => {
    const vault = tempDir('vault-');
    const configDir = tempDir('cc-');
    const id = randomUUID();
    conversation(id, vault, [], { configDir });
    expect((await lookup(id, vault)).status).toBe('missing');
    expect((await lookupClaudeTranscript(id, vault, { configDir })).status).toBe('match');
  });
});

describe('scanTranscript — streaming and caps', () => {
  it('stops at the first cwd inside the vault without reading the rest of a large file', async () => {
    const vault = await canonicalPath(tempDir('vault-'));
    const id = randomUUID();
    const file = writeTranscript(id, [...metaLines(id), entry(id, vault)]);
    const fd = openSync(file, 'a');
    const filler = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(10_000) } }) + '\n';
    for (let i = 0; i < 500; i++) writeSync(fd, filler); // ~5 MB
    closeSync(fd);
    const scan = await scanTranscript(file, vault);
    expect(scan.inVault).toBe(true);
    expect(scan.bytesRead).toBeLessThanOrEqual(64 * 1024);
  });

  it('skips a line longer than the line cap (e.g. a pasted image) and finds the cwd after it', async () => {
    const vault = await canonicalPath(tempDir('vault-'));
    const id = randomUUID();
    const huge = { ...entry(id, vault), message: { content: 'A'.repeat(TRANSCRIPT_MAX_LINE_BYTES + 10) } };
    const file = writeTranscript(id, [...metaLines(id), huge, entry(id, vault, 'attachment')]);
    const scan = await scanTranscript(file, vault);
    expect(scan).toMatchObject({ inVault: true, firstCwd: vault });
  });

  it('finds a cwd line that straddles a read-chunk boundary', async () => {
    const vault = await canonicalPath(tempDir('vault-'));
    const id = randomUUID();
    const pad = JSON.stringify({ type: 'file-history-snapshot', snapshot: 'p'.repeat(65_536 - 100) });
    const file = writeTranscript(id, [pad, entry(id, vault)]);
    expect((await scanTranscript(file, vault)).inVault).toBe(true);
  });

  it('parses a last line without a trailing newline, and CRLF line endings', async () => {
    const vault = await canonicalPath(tempDir('vault-'));
    const id = randomUUID();
    const a = writeTranscript(id, [...metaLines(id), entry(id, vault)], { trailingNewline: false });
    expect((await scanTranscript(a, vault)).inVault).toBe(true);
    const b = randomUUID();
    const crlf = writeTranscript(b, [`${JSON.stringify(metaLines(b)[0])}\r`, `${JSON.stringify(entry(b, vault))}\r`]);
    expect((await scanTranscript(crlf, vault)).inVault).toBe(true);
  });

  it('gives up at the byte cap: never reads more than maxScanBytes', async () => {
    const vault = await canonicalPath(tempDir('vault-'));
    const id = randomUUID();
    const dir = join(claudeHome(), 'projects', 'big');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    const fd = openSync(file, 'w');
    const block = Buffer.alloc(1024 * 1024, 0x61); // 3 MB, one line, no cwd anywhere
    for (let i = 0; i < 3; i++) writeSync(fd, block);
    writeSync(fd, `\n${JSON.stringify(entry(id, vault))}\n`);
    closeSync(fd);
    const scan = await scanTranscript(file, vault, { maxScanBytes: 1024 * 1024 });
    expect(scan).toMatchObject({ inVault: false, complete: false, bytesRead: 1024 * 1024 });
    expect(scan.firstCwd).toBeUndefined();
    expect((await lookupClaudeTranscript(id, vault, { configDir: claudeHome(), maxScanBytes: 1024 * 1024 })).status).toBe('unreadable');
    // With the default cap (8 MiB) the cwd after the 3 MB line is found.
    expect((await lookupClaudeTranscript(id, vault, { configDir: claudeHome() })).status).toBe('match');
    rmSync(file);
  });

  it('collects the first cwd even when it is outside the vault and keeps looking for one inside', async () => {
    const vault = await canonicalPath(tempDir('vault-'));
    const id = randomUUID();
    const file = writeTranscript(id, [entry(id, '/first/elsewhere'), entry(id, '/second/elsewhere')]);
    expect(await scanTranscript(file, vault)).toMatchObject({ firstCwd: '/first/elsewhere', inVault: false, complete: true });
  });
});
