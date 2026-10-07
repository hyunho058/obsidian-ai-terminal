// VaultFiles: path lookup across Unicode normalization, folder creation, trash vs. adapter fallbacks.
import type { Vault } from 'obsidian';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHiddenPath, parentPath, toArrayBuffer, VaultFiles } from '../../src/snapshot/restoreVault';
import { FileSystemAdapter, TFolder, Vault as MockVault } from '../mocks/obsidian';
import { FsVault, makeVault, readFile } from './helpers';

const buf = (s: string) => toArrayBuffer(Buffer.from(s));

describe('VaultFiles', () => {
  it('finds a note whatever the Unicode normalization of the indexed path (NFC, NFD, mixed)', () => {
    const vault = new MockVault(new FileSystemAdapter('/v'));
    const nfd = vault.addFile('한글/노트.md'.normalize('NFD'));
    const mixed = vault.addFile(`한글2/${'노트.md'.normalize('NFD')}`);
    const plain = vault.addFile('a/b.md');
    const files = new VaultFiles(vault as unknown as Vault);
    expect(files.find('한글/노트.md')).toBe(nfd);
    expect(files.find('한글2/노트.md')).toBe(mixed);
    expect(files.find('a/b.md')).toBe(plain);
    expect(files.find('a/missing.md')).toBeNull();
  });

  it('creates missing parent folders through the vault, reusing an existing (decomposed) folder', async () => {
    const dir = makeVault({ 'keep.md': 'k' });
    mkdirSync(join(dir, '프로젝트'.normalize('NFD')));
    const vault = new FsVault(dir);
    const files = new VaultFiles(vault.asVault());
    await files.write('프로젝트/새 폴더/깊이/노트.md', buf('내용'));
    await files.write('top/level/n.md', buf('n'));
    expect(vault.calls).toEqual([
      'createFolder:프로젝트/새 폴더',
      'createFolder:프로젝트/새 폴더/깊이',
      'createBinary:프로젝트/새 폴더/깊이/노트.md',
      'createFolder:top',
      'createFolder:top/level',
      'createBinary:top/level/n.md',
    ]);
    expect(readdirSync(dir).filter((n) => n.normalize('NFC') === '프로젝트')).toEqual(['프로젝트'.normalize('NFD')]);
    expect(readFile(dir, '프로젝트/새 폴더/깊이/노트.md')).toBe('내용');
  });

  it('writes over a note that exists on disk but is not indexed yet', async () => {
    const dir = makeVault({});
    const vault = new FsVault(dir);
    writeFileSync(join(dir, 'late.md'), 'written by another program');
    const files = new VaultFiles(vault.asVault());
    await files.write('late.md', buf('snapshot version'));
    expect(vault.calls).toEqual(['createBinary:late.md', 'writeBinary:late.md']);
    expect(readFile(dir, 'late.md')).toBe('snapshot version');
  });

  it('refuses to write over or trash a folder', async () => {
    const dir = makeVault({ 'x.md/inner.md': 'a folder named like a note' });
    const vault = new FsVault(dir);
    expect(vault.getAbstractFileByPath('x.md')).toBeInstanceOf(TFolder);
    const files = new VaultFiles(vault.asVault());
    await expect(files.write('x.md', buf('x'))).rejects.toThrow('a folder now has this name');
    await expect(files.trash('x.md')).rejects.toThrow('a folder now has this name');
    await expect(files.write('x.md/inner.md/deeper.md', buf('x'))).rejects.toThrow('"x.md/inner.md" is a file, not a folder');
  });

  it('trashes into the vault trash with Obsidian numbering; a missing note is reported as gone', async () => {
    const dir = makeVault({ 'a/n.md': '1', 'b/n.md': '2' });
    const vault = new FsVault(dir);
    const files = new VaultFiles(vault.asVault());
    expect(await files.trash('a/n.md')).toBe(true);
    expect(await files.trash('b/n.md')).toBe(true);
    expect(await files.trash('c/n.md')).toBe(false);
    expect(vault.trashed()).toEqual(['n 2.md', 'n.md']);
    expect(vault.calls.filter((c) => c.startsWith('trash:'))).toEqual(['trash:a/n.md:false', 'trash:b/n.md:false']);
  });

  it('path helpers', () => {
    expect(parentPath('a/b/c.md')).toBe('a/b');
    expect(parentPath('c.md')).toBe('');
    expect(isHiddenPath('.private/x.md')).toBe(true);
    expect(isHiddenPath('a/.b/x.md')).toBe(true);
    expect(isHiddenPath('a/b.c/x.md')).toBe(false);
    const pooled = Buffer.from('hello world').subarray(6);
    expect(Buffer.from(toArrayBuffer(pooled)).toString()).toBe('world');
  });
});
