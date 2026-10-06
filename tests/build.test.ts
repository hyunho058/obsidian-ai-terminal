import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNoNativeModules, buildOptions, copyStaticFiles, EXTERNALS, findSupportScripts, isSupportScript } from '../esbuild.config.mjs';
import { findTestDirs } from '../scripts/test-python.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function fakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'proj-'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ id: 'obsidian-ai-terminal', isDesktopOnly: true }));
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

describe('copyStaticFiles', () => {
  it('copies manifest, xterm.css + styles.css and support scripts flat; works with no scripts', () => {
    const root = fakeProject();
    const out = join(root, 'dist');
    expect(copyStaticFiles({ root, outDir: out })).toEqual([]);
    expect(readdirSync(out).sort()).toEqual(['manifest.json', 'styles.css']);
    const css = readFileSync(join(out, 'styles.css'), 'utf8');
    expect(css.indexOf('.xterm{}')).toBeLessThan(css.indexOf('.ai-terminal-container{}'));

    write(root, 'src/pty/pty_bridge.py', 'pty');
    write(root, 'src/snapshot/snapshot_hook.py', 'hook');
    expect(copyStaticFiles({ root, outDir: out })).toEqual(['pty_bridge.py', 'snapshot_hook.py']);
    expect(readFileSync(join(out, 'snapshot_hook.py'), 'utf8')).toBe('hook');
  });

  it('fails on two scripts with the same file name', () => {
    const root = fakeProject();
    write(root, 'src/a/util.py');
    write(root, 'src/b/util.py');
    expect(() => copyStaticFiles({ root, outDir: join(root, 'dist') })).toThrow(/Two support scripts/);
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
    for (const ext of ['obsidian', 'electron', '@codemirror/*', '@lezer/*', 'child_process', 'node:fs']) expect(EXTERNALS).toContain(ext);
  });
});

describe('manifest (R2.10)', () => {
  it('is desktop-only with the expected id', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ id: 'obsidian-ai-terminal', name: 'AI Terminal', isDesktopOnly: true, minAppVersion: '1.8.0', version: '0.1.0' });
    expect(m.description).toBeTruthy();
    expect(m.author).toBeTruthy();
  });

  it('dist/ (if built) has the required files and no native modules', () => {
    const dist = join(ROOT, 'dist');
    if (!existsSync(join(dist, 'main.js'))) return;
    for (const f of ['main.js', 'manifest.json', 'styles.css']) expect(existsSync(join(dist, f))).toBe(true);
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
