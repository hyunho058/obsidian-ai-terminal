import { describe, expect, it } from 'vitest';
import { BridgeError, pathCandidates, toVaultPath } from '../../src/bridge/paths';

describe('toVaultPath (R8.7, D19)', () => {
  it.each([
    ['Projects/a.md', 'Projects/a.md'],
    ['A.md', 'A.md'],
    ['./Notes/X.md', 'Notes/X.md'],
    ['Notes//X.md', 'Notes/X.md'],
    ['Notes/X.md/', 'Notes/X.md'],
    ['a/../b.md', 'b.md'],
    ['a/./b/../c.md', 'a/c.md'],
    ['Notes\\X.md', 'Notes/X.md'],
    ['  Notes/X.md  ', 'Notes/X.md'],
    ['한글 노트.md', '한글 노트.md'],
  ])('accepts %j → %j', (input, expected) => {
    expect(toVaultPath(input)).toBe(expected);
  });

  it.each([
    ['/etc/passwd'],
    ['/Users/me/vault/A.md'],
    ['\\etc\\passwd'],
    ['~/secret.md'],
    ['C:\\secret.md'],
    ['c:/secret.md'],
    ['file:///etc/passwd'],
    ['../secret.md'],
    ['..'],
    ['a/../../secret.md'],
    ['..\\secret.md'],
    ['Notes/..\\..\\secret.md'],
    ['.'],
    ['./'],
    [''],
    ['   '],
    ['a\0b.md'],
  ])('rejects %j', (input) => {
    expect(() => toVaultPath(input)).toThrow(BridgeError);
  });

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 3, {}, ['a.md']]) expect(() => toVaultPath(v)).toThrow(BridgeError);
  });

  it('errors carry the invalid-path code', () => {
    try {
      toVaultPath('../x.md');
      expect.unreachable();
    } catch (err) {
      expect((err as BridgeError).code).toBe('invalid-path');
    }
  });
});

describe('pathCandidates', () => {
  it('adds NFC / NFD forms and .md when there is no extension', () => {
    const nfc = '노트'.normalize('NFC');
    const c = pathCandidates(`Notes/${nfc}`);
    expect(c).toContain(`Notes/${nfc}`);
    expect(c).toContain(`Notes/${nfc}`.normalize('NFD'));
    expect(c).toContain(`Notes/${nfc}.md`);
    expect(pathCandidates('A.md')).toEqual(['A.md']);
  });
});
