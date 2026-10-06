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

if (homedir() !== home || tmpdir() !== tmp) throw new Error('tests/setup.ts: HOME / TMPDIR override did not take effect');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
