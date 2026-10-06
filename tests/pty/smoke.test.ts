// Opt-in: AI_TERMINAL_SMOKE=1 npx vitest run tests/pty/smoke.test.ts
// Runs the real `claude` and `agy` startup screens through PtyProcess for at most 8 s each, in a temp cwd and
// with the temp HOME from tests/setup.ts (so neither touches the user's real config), then stops them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShellEnv } from '../../src/env/shellEnv';
import { spawnPty } from '../../src/pty/PtyProcess';
import { HELPER_SOURCE, isAlive, testPythons, waitFor } from './helpers';

const SMOKE = process.env.AI_TERMINAL_SMOKE === '1';

function descendants(root: number): number[] {
  const r = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map<number, number[]>();
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) for (const c of children.get(stack.pop()!) ?? []) out.push(c), stack.push(c);
  return out;
}

describe.skipIf(!SMOKE)('smoke: real CLI startup screens through PtyProcess', () => {
  for (const name of ['claude', 'agy']) {
    it(`${name} renders an ANSI UI and leaves no processes behind`, async () => {
      const bin = join(userInfo().homedir, '.local', 'bin', name);
      if (!existsSync(bin)) {
        console.warn(`smoke: ${bin} not installed — skipped`);
        return;
      }
      const shellEnv = new ShellEnv();
      await shellEnv.capture();
      const cwd = mkdtempSync(join(tmpdir(), `smoke-${name}-`));
      const pythons = testPythons();
      const proc = spawnPty({
        python: pythons[pythons.length - 1]!,
        helperPath: HELPER_SOURCE,
        command: bin,
        cwd,
        env: shellEnv.getSpawnEnv({ PWD: cwd }),
        cols: 100,
        rows: 30,
      });
      const chunks: Uint8Array[] = [];
      proc.on('data', (c) => chunks.push(c));
      const text = () => Buffer.concat(chunks).toString('utf8');
      const t0 = Date.now();
      await waitFor(() => /\x1b\[/.test(text()) && text().length > 500, 6_000);
      proc.resize(120, 40);
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(1_500, 8_000 - (Date.now() - t0)))));
      const family = proc.programPid ? [proc.programPid, ...descendants(proc.programPid)] : [];
      proc.kill('smoke test done');
      const exit = await proc.exited;
      const stopMs = Date.now() - t0;
      const out = text();
      const visible = out
        .replace(/\x1b\[[0-9;?<>=$ ]*[A-Za-z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>()][0-9A-B]?/g, '')
        .replace(/\r/g, '')
        .split('\n')
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .join(' | ')
        .slice(0, 300);
      console.log(
        `smoke ${name}: ${out.length} chars, ansi=${/\x1b\[/.test(out)}, altScreen=${/\x1b\[\?1049h/.test(out)}, ` +
          `processes=${family.length}, exit=${JSON.stringify({ exitCode: exit.exitCode, signal: exit.signal })}, total ${stopMs} ms\n  ${visible}`,
      );
      expect(exit.notFound).toBe(false);
      expect(out).toMatch(/\x1b\[/);
      expect(await waitFor(() => family.every((p) => !isAlive(p)), 2_000)).toBe(true);
    }, 25_000);
  }
});
