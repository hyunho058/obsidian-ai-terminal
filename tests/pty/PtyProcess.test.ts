import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import { formatCommandNotFound, formatSpawnFailure } from '../../src/pty/messages';
import { HELPER_EVENT_MARKER, spawnPty, type PtyExit, type PtyProcess, type PtySpawnOptions } from '../../src/pty/PtyProcess';
import { HELPER_SOURCE, isAlive, testPythons, waitFor, writeScript } from './helpers';

const PYTHONS = testPythons();
const live: PtyProcess[] = [];

afterEach(async () => {
  for (const p of live.splice(0)) {
    if (!p.hasExited) {
      p.kill('test cleanup');
      await p.exited;
    }
  }
});

function start(python: string, command: string, args: string[], over: Partial<PtySpawnOptions> = {}): PtyProcess {
  const proc = spawnPty({
    python,
    helperPath: HELPER_SOURCE,
    command,
    args,
    cwd: tmpdir(),
    env: { ...process.env, TERM: 'xterm-256color' },
    cols: 100,
    rows: 30,
    ...over,
  });
  live.push(proc);
  return proc;
}

function collect(proc: PtyProcess): { chunks: Uint8Array[]; text: () => string } {
  const chunks: Uint8Array[] = [];
  proc.on('data', (c) => chunks.push(c));
  return { chunks, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function waitText(out: { text: () => string }, needle: string, timeoutMs = 10_000): Promise<void> {
  if (!(await waitFor(() => out.text().includes(needle), timeoutMs))) {
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(out.text().slice(-300))}`);
  }
}

const py = (python: string, source: string): [string, string[]] => [python, ['-c', source]];

describe('spawnPty (R2.1) argv and pipes', () => {
  it('runs `<python> -I pty_bridge.py COLS ROWS command args…` with four piped stdio streams', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fakepy-'));
    const record = join(dir, 'argv');
    const fake = writeScript(
      join(dir, 'python3'),
      `printf '%s\\n' "$@" > '${record}'\n` +
        `for fd in 0 1 2 3; do [ -e /dev/fd/$fd ] && echo "fd$fd" >> '${record}'; done\n` +
        `echo "pwd=$(pwd -P)" >> '${record}'\nexit 0\n`,
    );
    const cwd = mkdtempSync(join(tmpdir(), 'cwd-'));
    const proc = start(fake, 'claude', ['--model', 'sonnet'], { helperPath: '/plugin/pty_bridge.py', cwd });
    const exit = await proc.exited;
    expect(exit.exitCode).toBe(0);
    const lines = readFileSync(record, 'utf8').trim().split('\n');
    expect(lines.slice(0, 7)).toEqual(['-I', '/plugin/pty_bridge.py', '100', '30', 'claude', '--model', 'sonnet']);
    expect(lines).toEqual(expect.arrayContaining(['fd0', 'fd1', 'fd2', 'fd3']));
    expect(lines).toContain(`pwd=${(await import('node:fs')).realpathSync(cwd)}`);
  });

  it('reports a missing interpreter as an exit with `error` and no exit code', async () => {
    const proc = start('/nonexistent/python3', 'claude', []);
    const exit = await proc.exited;
    expect(exit.exitCode).toBeNull();
    expect(exit.error).toBeInstanceOf(Error);
    expect(exit.notFound).toBe(false);
    expect(formatSpawnFailure(exit)).toMatch(/^Could not start the terminal helper: /);
    proc.write('ignored');
    proc.resize(10, 10);
    proc.kill();
  });
});

describe.each(PYTHONS)('PtyProcess with %s', (python) => {
  it('relays output bytes unchanged, including Korean split across chunks (R2.2)', async () => {
    const [cmd, args] = py(
      python,
      [
        'import os, time',
        'data = "\\x1b[1;31m안녕하세요\\x1b[0m 😀".encode()',
        'os.write(1, data[:9]); time.sleep(0.3); os.write(1, data[9:] + b"\\n")',
      ].join('\n'),
    );
    const proc = start(python, cmd, args);
    const out = collect(proc);
    const exit = await proc.exited;
    expect(exit.exitCode).toBe(0);
    expect(out.chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of out.chunks) expect(c).toBeInstanceOf(Uint8Array);
    expect(out.text()).toContain('\x1b[1;31m안녕하세요\x1b[0m 😀\r\n');

    // The real consumer: xterm decodes UTF-8 across write() calls.
    const term = new Terminal({ cols: 100, rows: 5, allowProposedApi: true });
    for (const c of out.chunks) term.write(c);
    await new Promise<void>((r) => term.write('', r));
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('안녕하세요 😀');
    term.dispose();
  });

  it('writes input bytes to the program unchanged (R2.2)', async () => {
    const [cmd, args] = py(
      python,
      [
        'import os, tty',
        'tty.setraw(0)',
        'os.write(1, b"READY\\r\\n")',
        'data = b""',
        'while not data.endswith(b"END"):',
        '    data += os.read(0, 1024)',
        'os.write(1, b"HEX:" + data.hex().encode() + b"\\r\\n")',
      ].join('\n'),
    );
    const proc = start(python, cmd, args);
    const out = collect(proc);
    await waitText(out, 'READY');
    proc.write('안녕');
    proc.write(new Uint8Array([0x1b, 0x5b, 0x41, 0x03]));
    proc.write('END');
    await proc.exited;
    const sent = Buffer.concat([Buffer.from('안녕'), Buffer.from([0x1b, 0x5b, 0x41, 0x03]), Buffer.from('END')]);
    expect(out.text()).toContain(`HEX:${sent.toString('hex')}`);
  });

  it('resize() reaches the PTY and the program gets SIGWINCH (R2.3, R1.8)', async () => {
    const [cmd, args] = py(
      python,
      [
        'import fcntl, os, signal, struct, termios, time',
        'def size():',
        '    r, c, _, _ = struct.unpack("HHHH", fcntl.ioctl(1, termios.TIOCGWINSZ, b"\\0" * 8))',
        '    return c, r',
        'signal.signal(signal.SIGWINCH, lambda *a: os.write(1, ("WINCH %d %d\\n" % size()).encode()))',
        'os.write(1, ("INIT %d %d\\n" % size()).encode())',
        'while True: time.sleep(0.05)',
      ].join('\n'),
    );
    const proc = start(python, cmd, args);
    const out = collect(proc);
    await waitText(out, 'INIT 100 30');
    const t0 = Date.now();
    proc.resize(120, 40);
    await waitText(out, 'WINCH 120 40');
    expect(Date.now() - t0).toBeLessThan(500);
    expect([proc.cols, proc.rows]).toEqual([120, 40]);
    proc.resize(119.7, 0);
    await waitText(out, 'WINCH 119 1');
  });

  it('passes the exit code through (R2.4) and reports signal deaths as 128+N', async () => {
    const seven = start(python, ...py(python, 'import sys; sys.exit(7)'));
    const exit7 = await seven.exited;
    expect(exit7).toMatchObject({ exitCode: 7, signal: null, notFound: false });
    expect(formatSpawnFailure(exit7)).toBeNull();
    expect(seven.programPid).toEqual(expect.any(Number));

    const killed = start(python, ...py(python, 'import os, signal; os.kill(os.getpid(), signal.SIGTERM)'));
    expect((await killed.exited).exitCode).toBe(143);
  });

  it('reports a missing command as notFound with the settings hint (R3.4)', async () => {
    const proc = start(python, 'claudex-not-installed', ['--x']);
    const out = collect(proc);
    const exit = await proc.exited;
    expect(exit.exitCode).toBe(127);
    expect(exit.notFound).toBe(true);
    expect(exit.execError?.code).toBe('ENOENT');
    expect(exit.command).toBe('claudex-not-installed');
    expect(out.text()).toBe('');
    expect(formatSpawnFailure(exit)).toBe('Command not found: claudex-not-installed — check Settings › Profiles');
  });

  it('a program exiting 127 by itself is not reported as notFound', async () => {
    const exit = await start(python, '/bin/sh', ['-c', 'exit 127']).exited;
    expect(exit).toMatchObject({ exitCode: 127, notFound: false });
    expect(exit.execError).toBeUndefined();
  });

  it('kill() makes the helper stop a SIGHUP-ignoring program: SIGHUP, then SIGKILL after ~3 s (R7.1)', async () => {
    const [cmd, args] = py(
      python,
      'import os, signal, time\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\nos.write(1, b"READY\\n")\ntime.sleep(600)',
    );
    const proc = start(python, cmd, args);
    const out = collect(proc);
    await waitText(out, 'READY');
    const programPid = proc.programPid!;
    expect(isAlive(programPid)).toBe(true);
    const t0 = Date.now();
    proc.kill('closed by test');
    proc.write('ignored after kill');
    const exit = await proc.exited;
    const elapsed = Date.now() - t0;
    expect(exit).toMatchObject({ exitCode: 137, signal: null, killReason: 'closed by test' });
    expect(elapsed).toBeGreaterThanOrEqual(2_800);
    expect(elapsed).toBeLessThan(5_000);
    expect(isAlive(programPid)).toBe(false);
  });

  it('late exit listeners are still called', async () => {
    const proc = start(python, '/bin/sh', ['-c', 'exit 3']);
    await proc.exited;
    const got = await new Promise<PtyExit>((resolve) => proc.on('exit', resolve));
    expect(got.exitCode).toBe(3);
  });
});

describe('PtyProcess hard-kill fallback', () => {
  it('SIGKILLs a helper that ignores stdin EOF', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stuckpy-'));
    const stuck = writeScript(join(dir, 'python3'), `trap '' TERM HUP INT\necho '${HELPER_EVENT_MARKER}{"event":"started","pid":999999999}' >&2\nwhile :; do sleep 1; done\n`);
    const proc = start(stuck, 'x', [], { hardKillAfterMs: 300 });
    await waitFor(() => proc.programPid === 999999999, 5_000);
    proc.kill('test');
    const exit = await proc.exited;
    expect(exit.signal).toBe('SIGKILL');
    expect(exit.exitCode).toBeNull();
  });

  it('collects non-event stderr lines as diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noisypy-'));
    const noisy = writeScript(join(dir, 'python3'), `echo 'Traceback: boom' >&2\nexit 1\n`);
    const exit = await start(noisy, 'x', []).exited;
    expect(exit.exitCode).toBe(1);
    expect(exit.stderr).toBe('Traceback: boom');
  });
});

describe('messages', () => {
  it('formats the R3.4 line', () => {
    expect(formatCommandNotFound('claudex')).toBe('Command not found: claudex — check Settings › Profiles');
  });

  it('formats exec errors other than not-found', () => {
    expect(
      formatSpawnFailure({ exitCode: 126, signal: null, notFound: false, command: '/x', execError: { errno: 13, code: 'EACCES', message: 'Permission denied' } }),
    ).toBe('Cannot run /x: Permission denied — check Settings › Profiles');
  });
});
