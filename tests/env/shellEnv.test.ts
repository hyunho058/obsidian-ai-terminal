import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SHELL,
  ShellEnv,
  buildSpawnEnv,
  parseEnvBlock,
  pickLang,
  prependPath,
  resolveShell,
  stripEnv,
  type CommandRunner,
} from '../../src/env/shellEnv';
import { isAlive, waitFor, writeScript } from '../pty/helpers';

const LOCALES = 'C\nPOSIX\nen_US.UTF-8\nen_US\nko_KR\nko_KR.UTF-8\nko_KR.eucKR\n';

function runner(appleLocale: string | null = 'ko_KR', locales = LOCALES): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (file: string, args: readonly string[]) => {
    calls.push([file, ...args].join(' '));
    if (file.endsWith('defaults')) return appleLocale === null ? { code: 1, stdout: '' } : { code: 0, stdout: `${appleLocale}\n` };
    return { code: 0, stdout: locales };
  }) as CommandRunner & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** A fake login shell: prints noise, exports rc variables, records its argv/stdin, then evals the -c script. */
function fakeShell(dir: string, extra = ''): { shell: string; record: string } {
  const record = join(dir, 'shell-record');
  const shell = writeScript(
    join(dir, 'fakesh'),
    [
      `printf '%s\\n' "$@" >> '${record}'`,
      `if IFS= read -r line; then echo "STDIN:$line" >> '${record}'; else echo "STDIN:EOF" >> '${record}'; fi`,
      'echo "rc noise on stdout"',
      'echo "rc noise on stderr" >&2',
      "export MY_API_KEY='key-from-rc'",
      "export MULTILINE='line1\nline2'",
      'export PATH="/fake/rc/bin:$PATH"',
      'export ELECTRON_FROM_RC=1',
      extra,
      'for last; do :; done',
      'eval "$last"',
      'echo "trailing noise"',
    ].join('\n') + '\n',
  );
  return { shell, record };
}

const BASE = {
  HOME: '/Users/someone',
  PATH: '/usr/bin:/bin',
  USER: 'someone',
  SHELL: '/bin/zsh',
  ELECTRON_RUN_AS_NODE: '1',
  CHROME_DESKTOP: 'obsidian.desktop',
  TERM_PROGRAM: 'iTerm.app',
  TERM_PROGRAM_VERSION: '3.5',
  LC_TERMINAL: 'iTerm2',
  CLAUDECODE: '1',
  CLAUDE_CODE_SSE_PORT: '1234',
  CLAUDE_CODE_USE_BEDROCK: '1',
  PWD: '/',
  SHLVL: '1',
  KEEP_ME: 'yes',
};

describe('ShellEnv capture (R3.1, R3.2)', () => {
  it('captures the login shell environment between markers and layers it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const { shell, record } = fakeShell(dir);
    const run = runner();
    const env = new ShellEnv({ shell, baseEnv: BASE, homeDir: dir, run });
    expect(env.status).toBe('pending');
    await env.capture();
    expect(env.status).toBe('captured');
    expect(env.failureReason).toBeUndefined();

    const recorded = readFileSync(record, 'utf8').split('\n');
    expect(recorded.slice(0, 3)).toEqual(['-l', '-i', '-c']);
    expect(recorded).toContain('STDIN:EOF');

    const out = env.getSpawnEnv();
    expect(out.MY_API_KEY).toBe('key-from-rc');
    expect(out.MULTILINE).toBe('line1\nline2');
    expect(out.PATH!.split(':')[0]).toBe('/fake/rc/bin');
    expect(env.path).toBe(out.PATH);
    expect(out.KEEP_ME).toBe('yes');
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(out).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'obsidian-ai-terminal' });
    expect(Object.keys(out).filter((k) => /^(ELECTRON_|CHROME_)/.test(k))).toEqual([]);
    for (const k of ['TERM_PROGRAM_VERSION', 'LC_TERMINAL', 'CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'PWD', 'SHLVL', '_']) {
      expect(out[k], k).toBeUndefined();
    }
    expect(out.LANG).toBe('ko_KR.UTF-8');
    expect(run.calls).toEqual(['/usr/bin/defaults read -g AppleLocale', '/usr/bin/locale -a']);
  });

  it('captures once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const { shell, record } = fakeShell(dir);
    const env = new ShellEnv({ shell, baseEnv: BASE, homeDir: dir, run: runner() });
    await Promise.all([env.capture(), env.whenReady(), env.capture()]);
    expect(readFileSync(record, 'utf8').split('\n').filter((l) => l === '-c')).toHaveLength(1);
  });

  it('extras win and undefined removes a variable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const env = new ShellEnv({ shell: fakeShell(dir).shell, baseEnv: BASE, homeDir: dir, run: runner() });
    await env.capture();
    const out = env.getSpawnEnv({ OBSIDIAN_BRIDGE_URL: 'http://127.0.0.1:1/mcp', MY_API_KEY: undefined, TERM: 'dumb' });
    expect(out.OBSIDIAN_BRIDGE_URL).toBe('http://127.0.0.1:1/mcp');
    expect(out.MY_API_KEY).toBeUndefined();
    expect(out.TERM).toBe('dumb');
    expect(env.getSpawnEnv().MY_API_KEY).toBe('key-from-rc');
  });

  it('keeps LANG from the shell, else picks <AppleLocale>.UTF-8 only if installed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const withLang = new ShellEnv({ shell: fakeShell(dir, "export LANG='C.UTF-8'").shell, baseEnv: BASE, homeDir: dir, run: runner() });
    await withLang.capture();
    expect(withLang.getSpawnEnv().LANG).toBe('C.UTF-8');

    const dir2 = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const enKR = new ShellEnv({ shell: fakeShell(dir2).shell, baseEnv: BASE, homeDir: dir2, run: runner('en_KR') });
    await enKR.capture();
    expect(enKR.getSpawnEnv().LANG).toBe('en_US.UTF-8');

    const dir3 = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const failing: CommandRunner = async () => {
      throw new Error('no defaults');
    };
    const noProbe = new ShellEnv({ shell: fakeShell(dir3).shell, baseEnv: BASE, homeDir: dir3, run: failing });
    await noProbe.capture();
    expect(noProbe.getSpawnEnv().LANG).toBe('en_US.UTF-8');
  });

  it('reads ~/.zshrc through a real `zsh -l -i -c` (PATH gains ~/.local/bin)', async () => {
    if (!existsSync('/bin/zsh')) return;
    const home = mkdtempSync(join(tmpdir(), 'zhome-'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.zshrc'), 'export PATH="$HOME/.local/bin:$PATH"\nexport FROM_ZSHRC=1\n');
    const env = new ShellEnv({
      shell: '/bin/zsh',
      baseEnv: { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', USER: process.env.USER },
      homeDir: home,
      run: runner(),
    });
    const t0 = Date.now();
    await env.capture();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(env.status).toBe('captured');
    expect(env.path.split(':')).toContain(join(home, '.local', 'bin'));
    expect(env.getSpawnEnv().FROM_ZSHRC).toBe('1');
  });
});

describe('ShellEnv fallback (R3.3)', () => {
  it('times out, kills the shell process group and prepends ~/.local/bin:/opt/homebrew/bin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const pids = join(dir, 'pids');
    const shell = writeScript(join(dir, 'slowsh'), `sleep 30 &\necho "$$ $!" > '${pids}'\nwait\n`);
    const env = new ShellEnv({ shell, baseEnv: BASE, homeDir: dir, timeoutMs: 1_000, run: runner() });
    const t0 = Date.now();
    await env.capture();
    // generous bound: under a loaded full-suite run, process start/kill can lag well past the 1 s timeout
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(env.status).toBe('fallback');
    expect(env.failureReason).toMatch(/timed out after 1 s/);
    const out = env.getSpawnEnv();
    expect(out.PATH).toBe(`${dir}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`);
    expect(out.KEEP_ME).toBe('yes');
    expect(out.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(out.TERM_PROGRAM).toBe('obsidian-ai-terminal');
    expect(out.LANG).toBe('ko_KR.UTF-8');
    expect(await waitFor(() => existsSync(pids) && readFileSync(pids, 'utf8').includes(' '), 5_000)).toBe(true);
    const [shellPid, sleepPid] = readFileSync(pids, 'utf8').trim().split(' ').map(Number);
    expect(await waitFor(() => !isAlive(shellPid!) && !isAlive(sleepPid!), 5_000)).toBe(true);
  });

  it('falls back when the shell prints no markers or cannot start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const broken = writeScript(join(dir, 'brokensh'), 'echo "no env here"\nexit 3\n');
    const env = new ShellEnv({ shell: broken, baseEnv: BASE, homeDir: dir, run: runner() });
    await env.capture();
    expect(env.status).toBe('fallback');
    expect(env.failureReason).toMatch(/printed no environment \(exit 3\)/);

    const notExec = join(dir, 'plain-file');
    writeFileSync(notExec, '');
    const env2 = new ShellEnv({ shell: notExec, baseEnv: { ...BASE, SHELL: notExec }, homeDir: dir, run: runner(), timeoutMs: 4_000 });
    expect(env2.shell).toBe(DEFAULT_SHELL);
  });

  it('serves the fallback environment before the capture finishes, and dispose() stops the capture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const shell = writeScript(join(dir, 'slowsh'), 'sleep 30\n');
    const env = new ShellEnv({ shell, baseEnv: BASE, homeDir: dir, run: runner() });
    const pending = env.capture();
    expect(env.status).toBe('pending');
    expect(env.path.startsWith(`${dir}/.local/bin:/opt/homebrew/bin:`)).toBe(true);
    env.dispose();
    await pending;
    expect(env.status).toBe('fallback');
  });
});

describe('pure helpers', () => {
  it('parseEnvBlock splits NUL-separated pairs between the first and last marker', () => {
    const M = '__M__';
    expect(parseEnvBlock(`noise${M}A=1\0B=x=y\0C=multi\nline\0\0junk${M}tail`, M)).toEqual({ A: '1', B: 'x=y', C: 'multi\nline' });
    expect(parseEnvBlock('no markers', M)).toBeNull();
    expect(parseEnvBlock(`${M}${M}`, M)).toBeNull();
  });

  it('pickLang', () => {
    const avail = LOCALES.split('\n');
    expect(pickLang('ko_KR', avail)).toBe('ko_KR.UTF-8');
    expect(pickLang('en_KR', avail)).toBe('en_US.UTF-8');
    expect(pickLang('en_US@rg=krzzzz', avail)).toBe('en_US.UTF-8');
    expect(pickLang('ko_KR', ['ko_KR.utf8'])).toBe('ko_KR.utf8');
    expect(pickLang(undefined, avail)).toBe('en_US.UTF-8');
    expect(pickLang('$(rm -rf)', avail)).toBe('en_US.UTF-8');
  });

  it('stripEnv removes Electron/Chromium always and launcher variables only for inherited env', () => {
    const src = { ELECTRON_X: '1', CHROME_Y: '2', TERM_PROGRAM_VERSION: '3', ITERM_SESSION_ID: 'w0', A: 'a', U: undefined };
    expect(stripEnv(src, true)).toEqual({ A: 'a' });
    expect(stripEnv(src, false)).toEqual({ TERM_PROGRAM_VERSION: '3', ITERM_SESSION_ID: 'w0', A: 'a' });
  });

  it('prependPath de-duplicates', () => {
    expect(prependPath('/opt/homebrew/bin:/usr/bin', ['/h/.local/bin', '/opt/homebrew/bin'])).toBe('/h/.local/bin:/opt/homebrew/bin:/usr/bin');
    expect(prependPath(undefined, ['/a'])).toBe('/a');
  });

  it('buildSpawnEnv: captured values override the base; fallback without capture', () => {
    const captured = buildSpawnEnv({ base: { A: 'base', PATH: '/usr/bin' }, captured: { A: 'shell', PATH: '/x:/usr/bin' }, homeDir: '/h', lang: 'ko_KR.UTF-8' });
    expect(captured).toMatchObject({ A: 'shell', PATH: '/x:/usr/bin', LANG: 'ko_KR.UTF-8' });
    const fallback = buildSpawnEnv({ base: {}, captured: null, homeDir: '/h', lang: 'en_US.UTF-8' });
    expect(fallback.PATH).toBe('/h/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('resolveShell accepts only absolute executables', () => {
    expect(resolveShell('/bin/sh')).toBe('/bin/sh');
    expect(resolveShell('zsh')).toBe(DEFAULT_SHELL);
    expect(resolveShell(undefined)).toBe(DEFAULT_SHELL);
    expect(resolveShell('/nonexistent/fish')).toBe(DEFAULT_SHELL);
  });
});

describe('logging', () => {
  it('warns (through the logger) when falling back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellenv-'));
    const warn = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => log };
    const env = new ShellEnv({ shell: writeScript(join(dir, 'x'), 'exit 1\n'), baseEnv: BASE, homeDir: dir, run: runner(), log });
    await env.capture();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/fallback PATH/));
  });
});
