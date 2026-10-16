// Runs before every test file: point HOME, the XDG dirs and TMPDIR at a throwaway directory so no test can touch
// the user's real ~/.claude, ~/.gemini, ~/.config or ~/.local (worker rule 2). Child processes inherit it, and
// every temp dir made with os.tmpdir() during the file is removed afterwards.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'ai-terminal-test-'));
const home = join(root, 'home');
const tmp = join(root, 'tmp');
mkdirSync(home);
mkdirSync(tmp);
process.env.HOME = home;
process.env.TMPDIR = tmp;
process.env.XDG_CONFIG_HOME = join(home, '.config');
process.env.XDG_DATA_HOME = join(home, '.local', 'share');
process.env.XDG_STATE_HOME = join(home, '.local', 'state');
process.env.XDG_CACHE_HOME = join(home, '.cache');

// The plugin uses `window.setTimeout` & co. (popout-safe timers, Obsidian lint). Node-environment tests have no
// window: give them a bare EventTarget whose timers forward to the globals at call time, so vi.useFakeTimers applies.
if (typeof window === 'undefined') {
  const g = globalThis as Record<string, unknown>;
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) {
    win[name] = (...args: unknown[]) => (g[name] as (...a: unknown[]) => unknown)(...args);
  }
  g.window = win;
}

if (homedir() !== home || tmpdir() !== tmp) throw new Error('tests/setup.ts: HOME / TMPDIR override did not take effect');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
