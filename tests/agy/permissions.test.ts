// Deviation 22 — agy's allow rule `mcp(obsidian/*)` in ~/.gemini/antigravity-cli/settings.json, written under the temp
// HOME of tests/setup.ts (never the user's real file).
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGY_LOCK_FILE, FileLock } from '../../src/bridge/agyConfig';
import { AGY_ALLOW_RULE, AgyPermissions, agySettingsPath } from '../../src/bridge/agyPermissions';
import { supportDir } from '../../src/support/installScripts';

const DUMMY = 'DUMMY-SETTINGS-VALUE-sk-0123456789abcdef';
const settingsFile = (): string => join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const lockFile = (): string => join(supportDir(), AGY_LOCK_FILE);

/** The shape agy 1.3 writes, plus unknown keys and a dummy value that must survive. */
function userSettings(): Record<string, unknown> {
  return {
    allowNonWorkspaceAccess: true,
    model: 'gemini-3-pro',
    permissions: { allow: ['mcp(chrome_devtools/*)', 'shell(git status)'], deny: ['shell(rm -rf *)'] },
    trustedWorkspaces: ['/Users/me/vault', '/Users/me/code'],
    extra: { apiKey: DUMMY, nested: [1, 2, { deep: null }] },
  };
}

function writeSettings(raw: string | object, mode = 0o600): string {
  const text = typeof raw === 'string' ? raw : `${JSON.stringify(raw, null, 2)}\n`;
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), text);
  chmodSync(settingsFile(), mode);
  return text;
}

const read = (): Record<string, any> => JSON.parse(readFileSync(settingsFile(), 'utf8'));
const mode = (file: string): number => statSync(file).mode & 0o777;

beforeEach(() => {
  rmSync(join(homedir(), '.gemini'), { recursive: true, force: true });
  rmSync(lockFile(), { force: true });
});

describe('agy settings path', () => {
  it('is HOME-based (the temp HOME in tests, never the real one)', () => {
    expect(agySettingsPath()).toBe(settingsFile());
    expect(new AgyPermissions().settingsPath).toBe(settingsFile());
    expect(settingsFile().startsWith(userInfo().homedir + '/.gemini')).toBe(false);
    expect(AGY_ALLOW_RULE).toBe('mcp(obsidian/*)');
  });
});

describe('AgyPermissions.ensureAllowRule', () => {
  it('missing file → creates it (folder 0700, file 0600) with only the rule', async () => {
    expect(await new AgyPermissions().ensureAllowRule()).toEqual({ status: 'added' });
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{\n  "permissions": {\n    "allow": [\n      "mcp(obsidian/*)"\n    ]\n  }\n}\n');
    expect(mode(settingsFile())).toBe(0o600);
    expect(mode(dirname(settingsFile()))).toBe(0o700);
    expect(readdirSync(dirname(settingsFile()))).toEqual(['settings.json']); // no temp file left
    expect(existsSync(lockFile())).toBe(false);
  });

  it('existing file → rule appended; every other key, value and rule kept in order; mode 0600 kept', async () => {
    writeSettings(userSettings());
    expect(await new AgyPermissions().ensureAllowRule()).toEqual({ status: 'added' });
    const after = read();
    const want = userSettings();
    (want.permissions as { allow: string[] }).allow.push(AGY_ALLOW_RULE);
    expect(after).toEqual(want);
    expect(Object.keys(after)).toEqual(Object.keys(userSettings()));
    expect(Object.keys(after.permissions)).toEqual(['allow', 'deny']);
    expect(after.permissions.allow).toEqual(['mcp(chrome_devtools/*)', 'shell(git status)', 'mcp(obsidian/*)']);
    expect(after.extra.apiKey).toBe(DUMMY);
    expect(mode(settingsFile())).toBe(0o600);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(`${JSON.stringify(want, null, 2)}\n`);
    expect(readdirSync(dirname(settingsFile()))).toEqual(['settings.json']);
  });

  it('keeps another file mode too (0644)', async () => {
    writeSettings({ model: 'x' }, 0o644);
    expect(await new AgyPermissions().ensureAllowRule()).toEqual({ status: 'added' });
    expect(mode(settingsFile())).toBe(0o644);
    expect(read()).toEqual({ model: 'x', permissions: { allow: [AGY_ALLOW_RULE] } });
  });

  it('adds `permissions` / `allow` when missing, keeping other permission keys', async () => {
    writeSettings({ permissions: { deny: ['shell(x)'] } });
    expect(await new AgyPermissions().ensureAllowRule()).toEqual({ status: 'added' });
    expect(read()).toEqual({ permissions: { deny: ['shell(x)'], allow: [AGY_ALLOW_RULE] } });
  });

  it('rule already present → file byte-identical and not rewritten', async () => {
    const raw = writeSettings({ ...userSettings(), permissions: { allow: ['shell(ls)', AGY_ALLOW_RULE] } });
    const before = statSync(settingsFile());
    expect(await new AgyPermissions().ensureAllowRule()).toEqual({ status: 'present' });
    expect(readFileSync(settingsFile(), 'utf8')).toBe(raw);
    expect(statSync(settingsFile()).ino).toBe(before.ino);
    expect(statSync(settingsFile()).mtimeMs).toBe(before.mtimeMs);
  });

  it('unparsable file → untouched, skipped as a settings problem; the reason never quotes the file', async () => {
    const raw = writeSettings(`{"permissions": {"allow": [}, "token": "${DUMMY}"`);
    const outcome = await new AgyPermissions().ensureAllowRule();
    expect(outcome).toMatchObject({ status: 'skipped', settingsProblem: true });
    expect(JSON.stringify(outcome)).not.toContain(DUMMY);
    expect(JSON.stringify(outcome)).not.toContain('token');
    expect(readFileSync(settingsFile(), 'utf8')).toBe(raw);
  });

  it('odd shapes are never touched: allow not a list, permissions not an object, top level not an object', async () => {
    for (const odd of [
      { permissions: { allow: 'mcp(obsidian/*)' } },
      { permissions: { allow: { x: 1 } } },
      { permissions: ['mcp(obsidian/*)'] },
      { permissions: null },
      [1, 2],
      'just a string',
      null,
    ]) {
      const raw = writeSettings(`${JSON.stringify(odd, null, 2)}\n`);
      const outcome = await new AgyPermissions().ensureAllowRule();
      expect(outcome, JSON.stringify(odd)).toMatchObject({ status: 'skipped', settingsProblem: true });
      expect(readFileSync(settingsFile(), 'utf8')).toBe(raw);
    }
  });

  it('a read-only settings file is left alone', async () => {
    const raw = writeSettings({ model: 'x' }, 0o400);
    expect(await new AgyPermissions().ensureAllowRule()).toMatchObject({ status: 'skipped', settingsProblem: true, reason: expect.stringContaining('read-only') });
    expect(readFileSync(settingsFile(), 'utf8')).toBe(raw);
    expect(mode(settingsFile())).toBe(0o400);
  });

  it('a symlinked settings file is updated through the link (the link stays)', async () => {
    const real = join(homedir(), 'dotfiles', 'agy-settings.json');
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, `${JSON.stringify({ model: 'x' }, null, 2)}\n`, { mode: 0o600 });
    mkdirSync(dirname(settingsFile()), { recursive: true });
    symlinkSync(real, settingsFile());
    expect(await new AgyPermissions().ensureAllowRule()).toEqual({ status: 'added' });
    expect(lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
    expect(readdirSync(dirname(settingsFile()))).toEqual(['settings.json']);
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ model: 'x', permissions: { allow: [AGY_ALLOW_RULE] } });
    rmSync(dirname(real), { recursive: true, force: true });
  });

  it('a write failure (folder not writable) → failed, file untouched, lock released', async () => {
    const raw = writeSettings({ model: 'x' });
    chmodSync(dirname(settingsFile()), 0o500);
    try {
      const outcome = await new AgyPermissions().ensureAllowRule();
      expect(outcome).toMatchObject({ status: 'failed' });
      expect(readFileSync(settingsFile(), 'utf8')).toBe(raw);
      expect(existsSync(lockFile())).toBe(false);
    } finally {
      chmodSync(dirname(settingsFile()), 0o700);
    }
  });

  it('waits for the shared agy lock (held by another window) before touching the file', async () => {
    const other = new FileLock(lockFile());
    expect(await other.acquire(1000)).toBe(true);
    const pending = new AgyPermissions({ lockWaitMs: 5000 }).ensureAllowRule();
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(settingsFile())).toBe(false);
    other.release();
    expect(await pending).toEqual({ status: 'added' });
    expect(read().permissions.allow).toEqual([AGY_ALLOW_RULE]);
  });

  it('gives up (skipped, untouched) when the lock stays busy, and when cancelled', async () => {
    const other = new FileLock(lockFile());
    expect(await other.acquire(1000)).toBe(true);
    try {
      expect(await new AgyPermissions({ lockWaitMs: 200 }).ensureAllowRule()).toMatchObject({ status: 'skipped', reason: expect.stringContaining('another Obsidian window') });
    } finally {
      other.release();
    }
    expect(await new AgyPermissions().ensureAllowRule(() => true)).toMatchObject({ status: 'skipped' });
    expect(existsSync(settingsFile())).toBe(false);
  });

  it('two instances at once (shared lock) → one adds, the other finds it; the rule is there exactly once', async () => {
    writeSettings(userSettings());
    const results = await Promise.all([new AgyPermissions().ensureAllowRule(), new AgyPermissions().ensureAllowRule(), new AgyPermissions().ensureAllowRule()]);
    expect(results.map((r) => r.status).sort()).toEqual(['added', 'present', 'present']);
    expect(read().permissions.allow.filter((r: string) => r === AGY_ALLOW_RULE)).toHaveLength(1);
  });

  it('a file created by someone else between the read and the write is not replaced (retried instead)', async () => {
    let first = true;
    const perms = new AgyPermissions({
      writeNewFile: async (file, text, m) => {
        if (first) {
          first = false;
          writeSettings({ model: 'from agy' }); // appears while the plugin prepares its new file
        }
        writeFileSync(file, text, { mode: m, flag: 'wx' });
      },
    });
    expect(await perms.ensureAllowRule()).toEqual({ status: 'added' });
    expect(read()).toEqual({ model: 'from agy', permissions: { allow: [AGY_ALLOW_RULE] } });
  });

  it('dispose releases a held lock synchronously; a hung write never resolves past unload', async () => {
    const perms = new AgyPermissions({ writeNewFile: () => new Promise(() => {}) });
    void perms.ensureAllowRule();
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(lockFile())).toBe(true);
    perms.dispose();
    expect(existsSync(lockFile())).toBe(false);
    expect(await perms.ensureAllowRule()).toMatchObject({ status: 'skipped' });
  });
});

describe('AgyPermissions.removeAllowRule', () => {
  it('removes exactly mcp(obsidian/*); other keys and rules stay; mode kept', async () => {
    const s = userSettings();
    (s.permissions as { allow: string[] }).allow.splice(1, 0, AGY_ALLOW_RULE);
    writeSettings(s);
    expect(await new AgyPermissions().removeAllowRule()).toEqual({ status: 'removed' });
    expect(read()).toEqual(userSettings());
    expect(mode(settingsFile())).toBe(0o600);
  });

  it('never deletes the file or the (now empty) list', async () => {
    writeSettings({ permissions: { allow: [AGY_ALLOW_RULE] } });
    expect(await new AgyPermissions().removeAllowRule()).toEqual({ status: 'removed' });
    expect(read()).toEqual({ permissions: { allow: [] } });
  });

  it('missing file or rule → absent, nothing written; odd file → skipped, untouched', async () => {
    expect(await new AgyPermissions().removeAllowRule()).toEqual({ status: 'absent' });
    expect(existsSync(settingsFile())).toBe(false);
    const raw = writeSettings(userSettings());
    expect(await new AgyPermissions().removeAllowRule()).toEqual({ status: 'absent' });
    expect(readFileSync(settingsFile(), 'utf8')).toBe(raw);
    const bad = writeSettings('not json');
    expect(await new AgyPermissions().removeAllowRule()).toMatchObject({ status: 'skipped', settingsProblem: true });
    expect(readFileSync(settingsFile(), 'utf8')).toBe(bad);
  });
});
