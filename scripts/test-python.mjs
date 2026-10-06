#!/usr/bin/env node
// Runs every Python unittest suite (`test_*.py` under src/ and tests/) with /usr/bin/python3 (3.9, CLT) and with
// `python3` from PATH (Homebrew 3.14 here). Each directory with tests is run as
// `cd <dir> && python -m unittest test_a test_b …`, so a test imports the module next to it by plain name.
// Every run gets a throwaway HOME / XDG dirs / TMPDIR so no test can touch the user's real config.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_DIRS = ['src', 'tests'];
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', '.git']);

/** Map of directory → test module names (`test_*.py` without the extension). */
export function findTestDirs(root = ROOT) {
  const dirs = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /^test_\w*\.py$/.test(entry.name)) {
        if (!dirs.has(dir)) dirs.set(dir, []);
        dirs.get(dir).push(entry.name.slice(0, -3));
      }
    }
  };
  for (const d of SEARCH_DIRS) {
    const full = path.join(root, d);
    if (fs.existsSync(full)) walk(full);
  }
  return new Map([...dirs].sort(([a], [b]) => a.localeCompare(b)).map(([d, m]) => [d, m.sort()]));
}

function which(cmd) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Distinct interpreters to run: /usr/bin/python3 and python3 from PATH (deduplicated by real path). */
export function findInterpreters() {
  const candidates = ['/usr/bin/python3', which('python3')].filter(Boolean);
  const seen = new Map();
  for (const c of candidates) {
    let real;
    try {
      real = fs.realpathSync(c);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    const v = spawnSync(c, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], { encoding: 'utf8' });
    if (v.status === 0) seen.set(real, { path: c, version: v.stdout.trim() });
  }
  return [...seen.values()];
}

function main() {
  const dirs = findTestDirs();
  if (dirs.size === 0) {
    console.log('python: no test_*.py files under src/ or tests/ — nothing to run.');
    return 0;
  }
  const interpreters = findInterpreters();
  if (interpreters.length === 0) {
    console.error('python: no Python 3 interpreter found (/usr/bin/python3 or python3 on PATH).');
    return 1;
  }
  if (interpreters.length < 2) console.warn('python: only one distinct interpreter found; the 3.9 + current matrix is incomplete.');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-terminal-pytest-home-'));
  fs.mkdirSync(path.join(home, 'tmp'));
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const summary = [];
  let failed = false;
  try {
    for (const py of interpreters) {
      for (const [dir, modules] of dirs) {
        const rel = path.relative(ROOT, dir) || '.';
        console.log(`\n=== ${py.path} (${py.version}) — ${rel}`);
        const r = spawnSync(py.path, ['-m', 'unittest', ...modules], {
          cwd: dir,
          env,
          encoding: 'utf8',
        });
        process.stdout.write(r.stdout ?? '');
        process.stderr.write(r.stderr ?? '');
        const ran = /Ran (\d+) tests?/.exec(r.stderr ?? '')?.[1] ?? '?';
        const ok = r.status === 0;
        if (!ok) failed = true;
        summary.push(`${ok ? 'PASS' : 'FAIL'}  python ${py.version}  ${rel}  (${ran} tests)`);
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log(`\npython summary:\n  ${summary.join('\n  ')}`);
  return failed ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main());
