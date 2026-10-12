import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_SCRIPTS } from '../src/support/bundledScripts';
import { installSupportScripts, supportDir, supportScriptPath, SupportScripts, writeBundledScripts } from '../src/support/installScripts';

let pluginDir: string;
let home: string;

beforeEach(() => {
  // Fresh HOME per test (tests/setup.ts already isolates HOME per file).
  home = mkdtempSync(join(tmpdir(), 'home-'));
  process.env.HOME = home;
  pluginDir = mkdtempSync(join(tmpdir(), 'plugin-'));
});

describe('support script paths', () => {
  it('live under ~/.config/obsidian-ai-terminal of the current HOME', () => {
    expect(homedir()).toBe(home);
    expect(supportDir()).toBe(join(home, '.config', 'obsidian-ai-terminal'));
    expect(supportScriptPath('mcp_shim.py')).toBe(join(home, '.config', 'obsidian-ai-terminal', 'mcp_shim.py'));
  });

  it('reject names that are not plain file names', () => {
    for (const bad of ['../x.py', 'a/b.py', '.hidden', '']) expect(() => supportScriptPath(bad)).toThrow(/Invalid/);
  });
});

describe('installSupportScripts', () => {
  it('installs, then leaves unchanged files alone, then updates changed ones', async () => {
    writeFileSync(join(pluginDir, 'mcp_shim.py'), 'v1\n');
    const dest = supportScriptPath('mcp_shim.py');

    expect(await installSupportScripts(pluginDir, ['mcp_shim.py'])).toEqual([{ name: 'mcp_shim.py', path: dest, status: 'installed' }]);
    expect(readFileSync(dest, 'utf8')).toBe('v1\n');
    expect(statSync(dest).mode & 0o777).toBe(0o644);

    const old = new Date(2000, 0, 1);
    utimesSync(dest, old, old);
    expect((await installSupportScripts(pluginDir, ['mcp_shim.py']))[0]?.status).toBe('unchanged');
    expect(statSync(dest).mtime.getFullYear()).toBe(2000); // not rewritten

    writeFileSync(join(pluginDir, 'mcp_shim.py'), 'v2\n');
    expect((await installSupportScripts(pluginDir, ['mcp_shim.py']))[0]?.status).toBe('updated');
    expect(readFileSync(dest, 'utf8')).toBe('v2\n');
  });

  it('reports a script missing from the plugin folder without throwing', async () => {
    const [r] = await installSupportScripts(pluginDir, ['snapshot_hook.py']);
    expect(r?.status).toBe('missing');
  });

  it('reports a write failure', async () => {
    writeFileSync(join(pluginDir, 'x.py'), 'x');
    mkdirSync(join(home, '.config'), { recursive: true });
    writeFileSync(join(home, '.config', 'obsidian-ai-terminal'), 'not a dir');
    const [r] = await installSupportScripts(pluginDir, ['x.py']);
    expect(r?.status).toBe('failed');
  });
});

describe('SupportScripts', () => {
  it('installs every registered name once and signals completion', async () => {
    writeFileSync(join(pluginDir, 'mcp_shim.py'), 'shim');
    writeFileSync(join(pluginDir, 'snapshot_hook.py'), 'hook');
    const s = new SupportScripts(pluginDir);
    expect(s.register('mcp_shim.py')).toBe(supportScriptPath('mcp_shim.py'));
    s.register('snapshot_hook.py');
    s.register('mcp_shim.py');
    expect(s.registered()).toEqual(['mcp_shim.py', 'snapshot_hook.py']);
    const first = s.install();
    expect(s.install()).toBe(first);
    const results = await s.whenInstalled();
    expect(results.map((r) => r.status)).toEqual(['installed', 'installed']);
    expect(readFileSync(s.path('snapshot_hook.py'), 'utf8')).toBe('hook');
  });
});

describe('writeBundledScripts', () => {
  it('writes the helpers bundled in main.js into the plugin folder, then only what changed', async () => {
    const dir = join(pluginDir, 'plugins', 'ai-terminal'); // created on demand
    const first = await writeBundledScripts(dir);
    expect(first.map((r) => [r.name, r.status])).toEqual(Object.keys(BUNDLED_SCRIPTS).map((n) => [n, 'installed']));
    for (const [name, content] of Object.entries(BUNDLED_SCRIPTS)) {
      expect(readFileSync(join(dir, name), 'utf8')).toBe(content);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o644);
    }
    expect((await writeBundledScripts(dir)).every((r) => r.status === 'unchanged')).toBe(true);
    writeFileSync(join(dir, 'pty_bridge.py'), 'old version');
    const third = await writeBundledScripts(dir);
    expect(third.find((r) => r.name === 'pty_bridge.py')?.status).toBe('updated');
    expect(readFileSync(join(dir, 'pty_bridge.py'), 'utf8')).toBe(BUNDLED_SCRIPTS['pty_bridge.py']);
  });

  it('reports failures instead of rejecting', async () => {
    const file = join(pluginDir, 'not-a-dir');
    writeFileSync(file, 'x');
    const results = await writeBundledScripts(join(file, 'sub'), { 'a.py': 'a' });
    expect(results).toMatchObject([{ name: 'a.py', status: 'failed' }]);
    expect((await writeBundledScripts(pluginDir, { '../a.py': 'a' }))[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Invalid/) });
  });
});
