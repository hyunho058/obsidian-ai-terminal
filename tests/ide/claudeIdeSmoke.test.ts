// Opt-in check that real Claude Code connects to the IDE server (R10.3, R10.8, R0.4 groundwork):
//   AI_TERMINAL_CLAUDE_SMOKE=1 npx vitest run tests/ide/claudeIdeSmoke.test.ts
// Starts `claude` for ~9 s in a PTY with the temp HOME of tests/setup.ts (lock file in its ~/.claude/ide), a temp cwd
// (the "vault") and CLAUDE_CONFIG_DIR inside that HOME; nothing is typed, so no model request is made. Evidence: the
// handshake the server saw, Claude's debug log and the "⧉ 3 lines selected" indicator on Claude's screen.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeIdeContributor } from '../../src/bridge/claudeIdeContributor';
import { IdeConnection } from '../../src/bridge/ideModule';
import { IdeServer } from '../../src/bridge/ideServer';
import { ideLockDir } from '../../src/bridge/lockFile';
import { createLogger } from '../../src/util/log';
import { silentSink } from '../bridge/helpers';
import { FakeSelectionSource, snapshot } from './helpers';

const PTY_RUN = `
import os, pty, select, signal, sys, time
secs = float(sys.argv[1]); out = sys.argv[2]; cmd = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
end = time.time() + secs
buf = b''
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        buf += data
        if b'\\x1b[6n' in data:
            os.write(fd, b'\\x1b[1;1R')
open(out, 'wb').write(buf)
for sig in (signal.SIGTERM, signal.SIGKILL):
    try:
        os.kill(pid, sig)
    except Exception:
        pass
    time.sleep(0.3)
os.close(fd)
os.waitpid(pid, 0)
`;

async function runClaude(mode: 'sse-port' | 'lock-discovery') {
  const sink = silentSink();
  const log = createLogger('ide-smoke', sink);
  const vault = realpathSync(mkdtempSync(join(tmpdir(), 'claude-vault-')));
  const state = new FakeSelectionSource();
  state.current = snapshot({ path: 'X.md', absolutePath: join(vault, 'X.md'), text: 'a\nb\nc\n', from: { line: 0, ch: 0 }, to: { line: 3, ch: 0 }, fromLine: 1, toLine: 3 });
  const server = new IdeServer({ log, state, version: '0.1.0' });
  const conn = new IdeConnection(server, { lockDir: ideLockDir(), vaultPath: vault, pid: process.pid, log });
  await conn.enable();
  try {
    const configDir = join(homedir(), '.claude');
    mkdirSync(configDir, { recursive: true });
    const seed = JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [vault]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } });
    writeFileSync(join(homedir(), '.claude.json'), seed);
    writeFileSync(join(configDir, '.claude.json'), seed);
    const stamp = `${mode}-${Date.now()}`;
    const debugFile = join(vault, '..', `claude-debug-${stamp}.txt`);
    const screenFile = join(vault, '..', `claude-screen-${stamp}.bin`);

    const contribution = await createClaudeIdeContributor(() => conn)({ profile: 'claude', panelId: 'p', vaultPath: vault, phase: 'new', command: 'claude', baseArgs: [] });
    expect(contribution).toEqual({ args: ['--ide'], env: { CLAUDE_CODE_SSE_PORT: String(conn.port) } });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE_?CODE|^CLAUDECODE$|^CLAUDE_CONFIG_DIR$/.test(k)) env[k] = v;
    if (mode === 'sse-port') Object.assign(env, contribution!.env);
    Object.assign(env, { CLAUDE_CONFIG_DIR: configDir, TERM: 'xterm-256color', TERM_PROGRAM: 'obsidian-ai-terminal', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });

    // Async spawn: the IDE server runs in this process and must keep answering while Claude starts.
    const child = spawn('python3', ['-c', PTY_RUN, '9', screenFile, 'claude', ...contribution!.args!, '--debug-file', debugFile], { cwd: vault, env, stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => (child.kill('SIGKILL'), reject(new Error('pty runner hung'))), 30_000);
      child.on('exit', (c) => (clearTimeout(timer), resolve(c)));
    });
    expect(code).toBe(0);
    const debug = readFileSync(debugFile, 'utf8');
    const screen = readFileSync(screenFile).toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const ideLines = debug.split('\n').filter((l) => l.includes('MCP server "ide"'));
    console.log(`[ide smoke ${mode}] server log:\n${sink.lines.join('\n')}\n[ide smoke ${mode}] Claude debug:\n${ideLines.join('\n')}\n[ide smoke ${mode}] indicator: ${screen.match(/⧉[^\n\]]{0,40}/)?.[0] ?? '(none)'}`);
    expect(sink.lines.some((l) => /Claude Code connected \(pid \d+\)/.test(l))).toBe(true);
    expect(ideLines.some((l) => l.includes('Successfully connected (transport: ws-ide)'))).toBe(true);
    expect(ideLines.some((l) => l.includes('"serverVersion":{"name":"Obsidian"'))).toBe(true);
    expect(screen).toContain('3 lines selected');
    expect(debug).not.toContain(server.token);
  } finally {
    conn.dispose();
  }
}

describe.skipIf(process.env.AI_TERMINAL_CLAUDE_SMOKE !== '1')('real Claude Code + IDE connection', () => {
  it('R10.3: a panel spawned with --ide + CLAUDE_CODE_SSE_PORT connects, authenticates and shows the seeded selection', async () => {
    await runClaude('sse-port');
  }, 60_000);

  it('R10.8: Claude started without CLAUDE_CODE_SSE_PORT finds Obsidian through the lock file (cwd inside the vault)', async () => {
    await runClaude('lock-discovery');
  }, 60_000);
});
