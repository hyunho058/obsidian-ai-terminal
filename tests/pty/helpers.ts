import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HELPER_SOURCE = fileURLToPath(new URL('../../src/pty/pty_bridge.py', import.meta.url));

function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return join(dir, cmd);
    } catch {
      // keep looking
    }
  }
  return null;
}

/** /usr/bin/python3 (3.9, CLT) and python3 from PATH (Homebrew 3.14 here), de-duplicated, working ones only. */
export function testPythons(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of ['/usr/bin/python3', which('python3')]) {
    if (!c) continue;
    let real: string;
    try {
      real = realpathSync(c);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    const r = spawnSync(c, ['-c', 'import sys; assert sys.version_info >= (3, 9)']);
    if (r.status !== 0) continue;
    seen.add(real);
    out.push(c);
  }
  return out;
}

export function writeScript(path: string, body: string): string {
  writeFileSync(path, body.startsWith('#!') ? body : `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  const r = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = r.stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

/** Pids whose process group is `pgid`. */
export function groupMembers(pgid: number): number[] {
  const r = spawnSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  return r.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 3 && Number(p[1]) === pgid && !p[2]!.startsWith('Z'))
    .map((p) => Number(p[0]));
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}
