// Build: `node esbuild.config.mjs production` → dist/ (main.js, manifest.json, styles.css, *.py).
// Dev:   `node esbuild.config.mjs` → same output, rebuilt on change.
import esbuild from 'esbuild';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.join(ROOT, 'dist');
const SRC_DIR = path.join(ROOT, 'src');
const XTERM_CSS = path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');

export const EXTERNALS = [
  'obsidian',
  'electron',
  '@codemirror/*',
  '@lezer/*',
  // Optional native accelerators of `ws`: never bundled; ws falls back to pure JS when require() fails.
  'bufferutil',
  'utf-8-validate',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

/** Directories under src/ whose .py files are never shipped. */
const EXCLUDED_DIRS = new Set(['node_modules', '__pycache__', 'tests', 'test', 'fixtures', 'testdata']);

/** A shipped support script: any `.py` under src/ that is not a test file or inside a test/fixture dir. */
export function isSupportScript(file) {
  const base = path.basename(file);
  return base.endsWith('.py') && !base.startsWith('test_') && !base.endsWith('_test.py') && base !== 'conftest.py';
}

export function findSupportScripts(srcDir = SRC_DIR) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (entry.isFile() && isSupportScript(full)) {
        found.push(full);
      }
    }
  };
  if (fs.existsSync(srcDir)) walk(srcDir);
  return found.sort();
}

/** Copies manifest.json, styles.css (xterm.css + ours) and every support script (flat) into `outDir`. */
export function copyStaticFiles({ root = ROOT, outDir = OUT_DIR, srcDir = path.join(root, 'src') } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(outDir, 'manifest.json'));

  const xtermCss = path.join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
  const parts = [];
  if (fs.existsSync(xtermCss)) parts.push(`/* @xterm/xterm/css/xterm.css */\n${fs.readFileSync(xtermCss, 'utf8')}`);
  parts.push(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'styles.css'), parts.join('\n'));

  const scripts = findSupportScripts(srcDir);
  const byName = new Map();
  for (const file of scripts) {
    const name = path.basename(file);
    if (byName.has(name)) throw new Error(`Two support scripts would both be dist/${name}: ${byName.get(name)} and ${file}`);
    byName.set(name, file);
  }
  for (const [name, file] of byName) fs.copyFileSync(file, path.join(outDir, name));
  return [...byName.keys()];
}

/** Fails if the output contains a native module (R2.10). */
export function assertNoNativeModules(outDir = OUT_DIR) {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.node')) offenders.push(full);
    }
  };
  walk(outDir);
  const main = path.join(outDir, 'main.js');
  if (fs.existsSync(main) && /require\(\s*["'][^"']+\.node["']\s*\)/.test(fs.readFileSync(main, 'utf8'))) {
    offenders.push(`${main} (requires a .node file)`);
  }
  if (offenders.length) throw new Error(`Native modules are not allowed in the bundle:\n  ${offenders.join('\n  ')}`);
}

const noNativeModules = {
  name: 'no-native-modules',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({
      errors: [{ text: `Native module not allowed: ${args.path} (imported from ${args.importer})` }],
    }));
  },
};

export function buildOptions(prod) {
  return {
    absWorkingDir: ROOT,
    entryPoints: [path.join(SRC_DIR, 'main.ts')],
    outfile: path.join(OUT_DIR, 'main.js'),
    bundle: true,
    format: 'cjs',
    // Obsidian desktop runs plugins with Node integration; `node` makes packages like `ws` resolve their Node entry.
    platform: 'node',
    target: 'es2022',
    external: EXTERNALS,
    banner: { js: '/* AI Terminal (obsidian-ai-terminal) — bundled with esbuild. */' },
    sourcemap: prod ? false : 'inline',
    treeShaking: true,
    minify: false,
    logLevel: 'info',
    plugins: [noNativeModules],
  };
}

async function main() {
  const prod = process.argv[2] === 'production';
  if (prod) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    await esbuild.build(buildOptions(true));
    const scripts = copyStaticFiles();
    assertNoNativeModules();
    console.log(`dist/: main.js, manifest.json, styles.css${scripts.length ? `, ${scripts.join(', ')}` : ''}`);
    return;
  }

  const copy = () => {
    try {
      const scripts = copyStaticFiles();
      console.log(`[dev] copied manifest.json, styles.css${scripts.length ? `, ${scripts.join(', ')}` : ''}`);
    } catch (err) {
      console.error('[dev] copy failed:', err.message);
    }
  };
  const options = buildOptions(false);
  const ctx = await esbuild.context({
    ...options,
    plugins: [...options.plugins, { name: 'copy-static', setup: (b) => b.onEnd(copy) }],
  });
  await ctx.watch();
  // esbuild only watches bundled files; support scripts and styles are watched here.
  let pending = null;
  const schedule = () => {
    clearTimeout(pending);
    pending = setTimeout(copy, 100);
  };
  fs.watch(SRC_DIR, { recursive: true }, (_event, file) => {
    if (file && file.endsWith('.py')) schedule();
  });
  for (const f of ['styles.css', 'manifest.json']) fs.watch(path.join(ROOT, f), schedule);
  if (fs.existsSync(XTERM_CSS)) fs.watch(XTERM_CSS, schedule);
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
