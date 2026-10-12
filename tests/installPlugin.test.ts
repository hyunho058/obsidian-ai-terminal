import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { InstallError, installPlugin, isPermissionError, main } from '../scripts/install-plugin.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/install-plugin.mjs', import.meta.url));
const TARGET = join('.obsidian', 'plugins', 'ai-terminal');
const LEGACY = join('.obsidian', 'plugins', 'obsidian-ai-terminal');

let dist: string;
let vault: string;

function makeDist(): string {
  const d = mkdtempSync(join(tmpdir(), 'dist-'));
  writeFileSync(join(d, 'main.js'), 'module.exports = {};');
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ id: 'ai-terminal', version: '0.1.0' }));
  writeFileSync(join(d, 'styles.css'), '.x{}');
  return d;
}

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'vault-'));
  mkdirSync(join(v, '.obsidian'));
  return v;
}

function quietOut() {
  const lines: string[] = [];
  return { lines, log: (...a: unknown[]) => lines.push(a.join(' ')), error: (...a: unknown[]) => lines.push(a.join(' ')) };
}

beforeEach(() => {
  dist = makeDist();
  vault = makeVault();
});

describe('install-plugin (R16.2)', () => {
  it('CLI copies dist/ into <vault>/.obsidian/plugins/ai-terminal and keeps data.json', () => {
    mkdirSync(join(vault, TARGET), { recursive: true });
    writeFileSync(join(vault, TARGET, 'data.json'), '{"fontSize":20}');
    const r = spawnSync(process.execPath, [SCRIPT, vault, '--dist', dist], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    for (const f of ['main.js', 'manifest.json', 'styles.css']) {
      expect(readFileSync(join(vault, TARGET, f), 'utf8')).toBe(readFileSync(join(dist, f), 'utf8'));
    }
    expect(readFileSync(join(vault, TARGET, 'data.json'), 'utf8')).toBe('{"fontSize":20}');
    expect(r.stdout).toContain('Installed 3 files');
    expect(r.stdout).not.toContain('old plugin folder');
  });

  it('copies the settings of the old plugin folder (first id) once and says to delete that folder', async () => {
    mkdirSync(join(vault, LEGACY), { recursive: true });
    writeFileSync(join(vault, LEGACY, 'data.json'), '{"fontSize":16}');
    const out = quietOut();
    expect(await main([vault, '--dist', dist], out)).toBe(0);
    expect(readFileSync(join(vault, TARGET, 'data.json'), 'utf8')).toBe('{"fontSize":16}');
    expect(out.lines.join('\n')).toContain('Copied your settings');
    expect(out.lines.join('\n')).toContain(`The old plugin folder is still there: ${join(vault, LEGACY)}`);

    // A second install keeps the new settings.
    writeFileSync(join(vault, TARGET, 'data.json'), '{"fontSize":18}');
    const again = await installPlugin({ vault, distDir: dist });
    expect(again).toMatchObject({ legacy: join(vault, LEGACY), copiedSettings: false });
    expect(readFileSync(join(vault, TARGET, 'data.json'), 'utf8')).toBe('{"fontSize":18}');
  });

  it('expands ~ in the vault path', async () => {
    const home = process.env.HOME as string;
    const v = join(home, 'MyVault');
    mkdirSync(join(v, '.obsidian'), { recursive: true });
    const { target } = await installPlugin({ vault: '~/MyVault', distDir: dist });
    expect(target).toBe(join(v, TARGET));
    expect(existsSync(join(target, 'main.js'))).toBe(true);
  });

  it('refuses a folder without .obsidian', async () => {
    const notVault = mkdtempSync(join(tmpdir(), 'plain-'));
    await expect(installPlugin({ vault: notVault, distDir: dist })).rejects.toMatchObject({ code: 'NOT_A_VAULT' });
    const out = quietOut();
    expect(await main([notVault, '--dist', dist], out)).toBe(1);
    expect(out.lines.join('\n')).toMatch(/no \.obsidian folder/);
  });

  it('refuses a missing vault, missing dist files and no arguments', async () => {
    await expect(installPlugin({ vault: join(vault, 'nope'), distDir: dist })).rejects.toMatchObject({ code: 'NO_VAULT' });
    const emptyDist = mkdtempSync(join(tmpdir(), 'dist-empty-'));
    await expect(installPlugin({ vault, distDir: emptyDist })).rejects.toMatchObject({ code: 'NO_DIST' });
    expect(await main([], quietOut())).toBe(1);
  });

  it('explains the macOS permission block on EPERM (simulated)', async () => {
    const eperm = Object.assign(new Error(`EPERM: operation not permitted, copyfile '${dist}/main.js'`), { code: 'EPERM' });
    const fake = { ...fsp, copyFile: async () => Promise.reject(eperm) };
    const err = await installPlugin({ vault, distDir: dist, fsp: fake as typeof fsp }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).code).toBe('PERMISSION');
    const msg = (err as Error).message;
    expect(msg).toContain('operation not permitted');
    expect(msg).toContain('Privacy & Security › Files and Folders');
    expect(msg).toContain('Full Disk Access');
    expect(msg).toContain('Finder');
    expect(msg).toContain(join(vault, TARGET));
  });

  it('treats EPERM while checking the vault as a permission problem, not "not a vault"', async () => {
    const eperm = Object.assign(new Error('EPERM: operation not permitted, stat'), { code: 'EPERM' });
    const fake = { ...fsp, stat: async () => Promise.reject(eperm) };
    await expect(installPlugin({ vault, distDir: dist, fsp: fake as typeof fsp })).rejects.toMatchObject({ code: 'PERMISSION' });
  });

  it('exits 2 with instructions on a real permission error', () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const plugins = join(vault, '.obsidian', 'plugins');
    mkdirSync(plugins);
    chmodSync(plugins, 0o500);
    try {
      const r = spawnSync(process.execPath, [SCRIPT, vault, '--dist', dist], { encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Privacy & Security');
    } finally {
      chmodSync(plugins, 0o700);
    }
  });

  it('isPermissionError recognises EPERM / EACCES / message text', () => {
    expect(isPermissionError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true);
    expect(isPermissionError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(true);
    expect(isPermissionError(new Error('ls: Notes: Operation not permitted'))).toBe(true);
    expect(isPermissionError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
  });
});
