import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PYTHON_NOT_FOUND_MESSAGE,
  PythonNotFoundError,
  PythonResolver,
  findOnPath,
  parseVersion,
  probePython,
  type PythonResolverOptions,
} from '../../src/pty/python';
import { writeScript } from './helpers';

/** A fake interpreter that logs each probe to `<dir>/probes` and prints `output` (or misbehaves). */
function fakePython(dir: string, name: string, output: string | { exit: number } | 'hang'): string {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'probes');
  let body = `echo "$0" >> '${log}'\n`;
  if (output === 'hang') body += 'sleep 30\n';
  else if (typeof output === 'string') body += `echo '${output}'\n`;
  else body += `exit ${output.exit}\n`;
  return writeScript(join(dir, name), body);
}

function probes(dir: string): string[] {
  const f = join(dir, 'probes');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : [];
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pyres-'));
  const a = join(root, 'a');
  const b = join(root, 'b');
  const sys = join(root, 'sys');
  mkdirSync(a);
  mkdirSync(b);
  mkdirSync(sys);
  let settingsPath = '';
  let searchPath = `${a}:${b}`;
  const make = (over: Partial<PythonResolverOptions> = {}) =>
    new PythonResolver({
      getSettingsPath: () => settingsPath,
      getSearchPath: () => searchPath,
      systemPython: join(sys, 'python3'),
      homeDir: () => root,
      ...over,
    });
  return {
    root,
    a,
    b,
    sys,
    make,
    setSettings: (p: string) => (settingsPath = p),
    setSearchPath: (p: string) => (searchPath = p),
  };
}

describe('PythonResolver (D7, R2.5)', () => {
  it('prefers the settings override', async () => {
    const t = setup();
    fakePython(t.a, 'python3', '(3, 14)');
    const custom = fakePython(join(t.root, 'custom'), 'python', '(3, 11)');
    t.setSettings(custom);
    expect(await t.make().resolve()).toBe(custom);
  });

  it('then python3 on the resolved PATH', async () => {
    const t = setup();
    const first = fakePython(t.a, 'python3', '(3, 14)');
    fakePython(t.b, 'python3', '(3, 12)');
    fakePython(t.sys, 'python3', '(3, 9)');
    expect(await t.make().resolve()).toBe(first);
    expect(probes(t.b)).toEqual([]);
  });

  it('skips a too-old or broken python3 and keeps looking along PATH, then the system Python', async () => {
    const t = setup();
    fakePython(t.a, 'python3', '(3, 8)');
    fakePython(t.b, 'python3', { exit: 1 });
    const system = fakePython(t.sys, 'python3', '(3, 9)');
    expect(await t.make().resolve()).toBe(system);
  });

  it('falls back from a broken settings path to PATH', async () => {
    const t = setup();
    t.setSettings(join(t.root, 'nope', 'python3'));
    const onPath = fakePython(t.a, 'python3', '(3, 10)');
    expect(await t.make().resolve()).toBe(onPath);
  });

  it('resolves a bare settings name on PATH and expands ~/', async () => {
    const t = setup();
    const named = fakePython(t.b, 'python3.12', '(3, 12)');
    fakePython(t.a, 'python3', '(3, 14)');
    t.setSettings('python3.12');
    expect(await t.make().resolve()).toBe(named);

    const home = fakePython(join(t.root, '.pyenv', 'bin'), 'python', '(3, 13)');
    t.setSettings('~/.pyenv/bin/python');
    expect(await t.make().resolve()).toBe(home);
  });

  it('throws PythonNotFoundError with the panel message when nothing works', async () => {
    const t = setup();
    fakePython(t.a, 'python3', '(2, 7)');
    fakePython(t.sys, 'python3', 'garbage');
    t.setSettings('/missing/python');
    const err = await t.make().resolve().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PythonNotFoundError);
    expect((err as Error).message).toBe('Python 3 not found — install it or set the path in Settings');
    expect(PYTHON_NOT_FOUND_MESSAGE).toBe((err as Error).message);
    const attempts = (err as PythonNotFoundError).attempts;
    expect(attempts.map((a) => a.source)).toEqual(['settings', 'path', 'system']);
    expect(attempts[1]!.reason).toMatch(/2\.7 is older than 3\.9/);
    expect(attempts[2]!.reason).toMatch(/unexpected output/);
  });

  it('reports a missing system Python when PATH has none', async () => {
    const t = setup();
    const err = (await t.make().resolve().catch((e: unknown) => e)) as PythonNotFoundError;
    expect(err).toBeInstanceOf(PythonNotFoundError);
    expect(err.attempts).toEqual([{ path: join(t.sys, 'python3'), source: 'system', reason: 'not found' }]);
  });

  it('caches the result, shares concurrent lookups and re-probes after invalidate()', async () => {
    const t = setup();
    const p = fakePython(t.a, 'python3', '(3, 14)');
    const resolver = t.make();
    const [x, y] = await Promise.all([resolver.resolve(), resolver.resolve()]);
    expect([x, y]).toEqual([p, p]);
    await resolver.resolve();
    expect(probes(t.a)).toHaveLength(1);
    expect(resolver.current()).toBe(p);
    resolver.invalidate();
    expect(resolver.current()).toBeUndefined();
    await resolver.resolve();
    expect(probes(t.a)).toHaveLength(2);
  });

  it('does not cache failures, and re-resolves when the cached interpreter disappears', async () => {
    const t = setup();
    const resolver = t.make();
    await expect(resolver.resolve()).rejects.toBeInstanceOf(PythonNotFoundError);
    const later = fakePython(t.b, 'python3', '(3, 13)');
    expect(await resolver.resolve()).toBe(later);
    rmSync(later);
    const other = fakePython(t.a, 'python3', '(3, 12)');
    expect(await resolver.resolve()).toBe(other);
  });

  it('probes the same interpreter only once when PATH lists it twice (symlinks)', async () => {
    const t = setup();
    const real = fakePython(t.a, 'python3', '(3, 14)');
    symlinkSync(real, join(t.b, 'python3'));
    t.setSearchPath(`${t.b}:${t.a}`);
    const resolver = t.make({ probe: async () => ({ error: 'nope' }) });
    const err = (await resolver.resolve().catch((e: unknown) => e)) as PythonNotFoundError;
    expect(err.attempts.filter((a) => a.source === 'path')).toEqual([{ path: join(t.b, 'python3'), source: 'path', reason: 'nope' }]);
  });

  it('moves on when a probe fails (e.g. timed out)', async () => {
    const t = setup();
    fakePython(t.a, 'python3', 'hang');
    const system = fakePython(t.sys, 'python3', '(3, 9)');
    const resolver = t.make({
      probe: (p) => (p.startsWith(t.a) ? Promise.resolve({ error: 'timed out after 5000 ms' }) : probePython(p)),
    });
    expect(await resolver.resolve()).toBe(system);
  });

  it('picks /opt/homebrew/bin/python3 from a real PATH with an empty setting (R2.5 Given)', async () => {
    if (!existsSync('/opt/homebrew/bin/python3')) return;
    const resolver = new PythonResolver({ getSettingsPath: () => '', getSearchPath: () => '/opt/homebrew/bin:/usr/bin:/bin' });
    expect(await resolver.resolve()).toBe('/opt/homebrew/bin/python3');
  });

  it('validates the real /usr/bin/python3 (3.9) as usable (R2.6)', async () => {
    if (!existsSync('/usr/bin/python3')) return;
    const r = await probePython('/usr/bin/python3');
    if ('error' in r) expect(r.error).toMatch(/Command Line Tools/);
    else expect(r.version[0]).toBe(3);
  });
});

describe('helpers', () => {
  it('parseVersion reads the probe output', () => {
    expect(parseVersion('(3, 14)\n')).toEqual([3, 14]);
    expect(parseVersion('(3,9)')).toEqual([3, 9]);
    expect(parseVersion('3.9')).toBeNull();
  });

  it('findOnPath returns executables in PATH order and ignores relative entries', () => {
    const t = setup();
    const one = fakePython(t.a, 'python3', '(3, 14)');
    const two = fakePython(t.b, 'python3', '(3, 14)');
    expect(findOnPath('python3', `relative:${t.a}::${t.b}:${t.a}`)).toEqual([one, two]);
  });
});
