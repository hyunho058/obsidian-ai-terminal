import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNoNativeModules, buildOptions, copyStaticFiles, EXTERNALS, findSupportScripts, isSupportScript } from '../esbuild.config.mjs';
import { findTestDirs } from '../scripts/test-python.mjs';
import { BUNDLED_SCRIPTS } from '../src/support/bundledScripts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function fakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'proj-'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ id: 'ai-terminal', isDesktopOnly: true }));
  writeFileSync(join(root, 'styles.css'), '.ai-terminal-container{}');
  mkdirSync(join(root, 'node_modules', '@xterm', 'xterm', 'css'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), '.xterm{}');
  return root;
}

function write(root: string, rel: string, content = '#'): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('support script selection', () => {
  it('ships non-test .py files only', () => {
    expect(isSupportScript('src/pty/pty_bridge.py')).toBe(true);
    expect(isSupportScript('src/pty/test_pty_bridge.py')).toBe(false);
    expect(isSupportScript('src/pty/bridge_test.py')).toBe(false);
    expect(isSupportScript('src/pty/conftest.py')).toBe(false);
    expect(isSupportScript('src/pty/x.ts')).toBe(false);
  });

  it('skips tests/, fixtures/ and __pycache__/ folders', () => {
    const root = fakeProject();
    write(root, 'src/pty/pty_bridge.py');
    write(root, 'src/bridge/mcp_shim.py');
    write(root, 'src/pty/test_pty_bridge.py');
    write(root, 'src/pty/fixtures/fake_tui.py');
    write(root, 'src/snapshot/tests/helper.py');
    write(root, 'src/snapshot/__pycache__/x.py');
    expect(findSupportScripts(join(root, 'src')).map((f: string) => f.slice(root.length + 1))).toEqual([
      'src/bridge/mcp_shim.py',
      'src/pty/pty_bridge.py',
    ]);
  });
});

describe('the real project (R16.1)', () => {
  const SUPPORT_SCRIPTS = ['mcp_shim.py', 'pty_bridge.py', 'snapshot_hook.py'];

  it('ships exactly the three support scripts from src/', () => {
    expect(findSupportScripts().map((f: string) => basename(f)).sort()).toEqual(SUPPORT_SCRIPTS);
  });

  it('bundles every support script into main.js with its exact content (Obsidian installs only three files)', () => {
    expect(Object.keys(BUNDLED_SCRIPTS).sort()).toEqual(SUPPORT_SCRIPTS);
    for (const file of findSupportScripts()) expect(BUNDLED_SCRIPTS[basename(file)]).toBe(readFileSync(file, 'utf8'));
  });

  it('the static-copy step of `npm run build` writes manifest.json and styles.css', () => {
    const out = mkdtempSync(join(tmpdir(), 'dist-'));
    copyStaticFiles({ outDir: out });
    expect(readdirSync(out).sort()).toEqual(['manifest.json', 'styles.css']);
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    const css = readFileSync(join(out, 'styles.css'), 'utf8');
    expect(css).toContain('.xterm');
    expect(css).toContain(readFileSync(join(ROOT, 'styles.css'), 'utf8'));
    expect(() => assertNoNativeModules(out)).not.toThrow();
  });
});

describe('copyStaticFiles', () => {
  it('copies manifest and xterm.css + styles.css, never the .py helpers', () => {
    const root = fakeProject();
    const out = join(root, 'dist');
    write(root, 'src/pty/pty_bridge.py', 'pty');
    copyStaticFiles({ root, outDir: out });
    expect(readdirSync(out).sort()).toEqual(['manifest.json', 'styles.css']);
    const css = readFileSync(join(out, 'styles.css'), 'utf8');
    expect(css.indexOf('.xterm{}')).toBeLessThan(css.indexOf('.ai-terminal-container{}'));
  });
});

describe('native module guard (R2.10)', () => {
  it('rejects .node files and require("x.node") in main.js', () => {
    const out = mkdtempSync(join(tmpdir(), 'out-'));
    writeFileSync(join(out, 'main.js'), 'require("fs");');
    expect(() => assertNoNativeModules(out)).not.toThrow();
    writeFileSync(join(out, 'main.js'), 'require("./build/Release/pty.node");');
    expect(() => assertNoNativeModules(out)).toThrow(/Native modules/);
    writeFileSync(join(out, 'main.js'), '');
    writeFileSync(join(out, 'addon.node'), '');
    expect(() => assertNoNativeModules(out)).toThrow(/addon\.node/);
  });

  it('build options target Obsidian desktop', () => {
    const o = buildOptions(true);
    expect(o.format).toBe('cjs');
    expect(o.platform).toBe('node');
    expect(o.target).toBe('es2022');
    expect(o.loader).toEqual({ '.py': 'text' });
    for (const ext of ['obsidian', 'electron', '@codemirror/*', '@lezer/*', 'child_process', 'node:fs']) expect(EXTERNALS).toContain(ext);
  });
});

describe('manifest (R2.10)', () => {
  it('is desktop-only with the expected id', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ id: 'ai-terminal', name: 'AI Terminal', isDesktopOnly: true, minAppVersion: '1.13.0' });
    expect(m.description).toBeTruthy();
    expect(m.author).toBeTruthy();
  });

  it('versions.json maps every release to its minAppVersion and lists the current version', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    const versions = JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8')) as Record<string, string>;
    expect(versions[m.version]).toBe(m.minAppVersion);
    for (const [version, minApp] of Object.entries(versions)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(minApp).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('follows the Community directory rules for id, name, version and description', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    expect(m.id).toMatch(/^[a-z-]+$/);
    expect(m.id).not.toMatch(/obsidian/i);
    expect(m.id).not.toMatch(/plugin$/);
    expect(m.name).not.toMatch(/obsi|sidian|plugin/i);
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.description.length).toBeLessThanOrEqual(250);
    expect(m.description).toMatch(/\.$/);
    expect(m.description).not.toMatch(/^This is a plugin/i);
    expect(m.fundingUrl).toBeUndefined();
  });

  it('dist/ (if built) holds exactly main.js, manifest.json and styles.css, with the helpers inside main.js (R16.1)', () => {
    const dist = join(ROOT, 'dist');
    if (!existsSync(join(dist, 'main.js'))) return;
    expect(readdirSync(dist).sort()).toEqual(['main.js', 'manifest.json', 'styles.css']);
    expect(readFileSync(join(dist, 'main.js'), 'utf8')).toContain('pty_bridge.py');
    expect(() => assertNoNativeModules(dist)).not.toThrow();
  });
});

describe('python test discovery', () => {
  it('finds nothing in a project without Python tests', () => {
    const root = fakeProject();
    write(root, 'src/pty/pty_bridge.py');
    expect(findTestDirs(root).size).toBe(0);
  });

  it('groups test modules by directory', () => {
    const root = fakeProject();
    write(root, 'src/pty/test_a.py');
    write(root, 'src/pty/test_b.py');
    write(root, 'tests/python/test_c.py');
    write(root, 'src/pty/__pycache__/test_x.py');
    const found = findTestDirs(root);
    expect([...found.entries()].map(([d, m]) => [d.slice(root.length + 1), m])).toEqual([
      ['src/pty', ['test_a', 'test_b']],
      ['tests/python', ['test_c']],
    ]);
  });
});
