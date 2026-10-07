// Opt-in check that real Claude Code accepts the bridge's --mcp-config and connects (R11.1 / R11.2 groundwork):
//   AI_TERMINAL_CLAUDE_SMOKE=1 npx vitest run tests/bridge/claudeSmoke.test.ts
// Starts `claude` for ~8 s in a PTY with the temp HOME of tests/setup.ts, a temp cwd and its own CLAUDE_CONFIG_DIR;
// nothing is typed, so no model request is made. Evidence: Claude's debug log + the requests the bridge received.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, createClaudeMcpContributor } from '../../src/bridge/claudeMcpContributor';
import { BridgeHttpServer } from '../../src/bridge/httpServer';
import { createBridgeMcpServer } from '../../src/bridge/tools';
import { BridgeRouteRegistry } from '../../src/core/routes';
import { createLogger } from '../../src/util/log';
import { silentSink } from './helpers';

const PTY_RUN = `
import os, pty, select, signal, sys, time
secs = float(sys.argv[1]); cmd = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
end = time.time() + secs
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        if b'\\x1b[6n' in data:
            os.write(fd, b'\\x1b[1;1R')
for sig in (signal.SIGTERM, signal.SIGKILL):
    try:
        os.kill(pid, sig)
    except Exception:
        pass
    time.sleep(0.3)
# Close the master first: a process exiting on macOS blocks in tty close until unread output drains.
os.close(fd)
os.waitpid(pid, 0)
`;

describe.skipIf(process.env.AI_TERMINAL_CLAUDE_SMOKE !== '1')('real Claude Code + bridge --mcp-config', () => {
  it('connects to the obsidian server with the token expanded from the environment', async () => {
    const calls: string[] = [];
    const state = {
      getActiveNote: () => (calls.push('get_active_note'), { path: 'X.md', content: 'x', cursorLine: 1 }),
      getSelection: () => ({ text: '' as const, reason: 'none' }),
      listOpenNotes: () => [],
      getLinks: () => ({ outgoing: [], backlinks: [] }),
      openNote: async (p: string) => ({ opened: p }),
      currentSelection: () => null,
      onChange: () => () => {},
    };
    let mcpRequests = 0;
    const server = new BridgeHttpServer({
      routes: new BridgeRouteRegistry(),
      createMcpServer: () => (mcpRequests++, createBridgeMcpServer(state)),
      log: createLogger('smoke', silentSink()),
    });
    await server.start();
    try {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claude-cwd-')));
      const configDir = join(homedir(), '.claude');
      mkdirSync(configDir, { recursive: true });
      const seed = JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } });
      writeFileSync(join(homedir(), '.claude.json'), seed);
      writeFileSync(join(configDir, '.claude.json'), seed);
      const debugFile = join(cwd, '..', `claude-debug-${Date.now()}.txt`);

      const plan = await createClaudeMcpContributor(() => server)({ profile: 'claude', panelId: 'p', vaultPath: cwd, phase: 'new', command: 'claude', baseArgs: [] });
      expect(plan).toBeTruthy();
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE_?CODE|^CLAUDECODE$/.test(k)) env[k] = v;
      Object.assign(env, plan!.env, { CLAUDE_CONFIG_DIR: configDir, TERM: 'xterm-256color', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
      expect(env[BRIDGE_TOKEN_ENV]).toBe(server.token);
      expect(env[BRIDGE_URL_ENV]).toBe(server.baseUrl);

      // Async spawn: the bridge server runs in this process and must keep answering while Claude starts.
      const child = spawn('python3', ['-c', PTY_RUN, '8', 'claude', ...plan!.args!, '--debug-file', debugFile], { cwd, env, stdio: 'ignore' });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => (child.kill('SIGKILL'), reject(new Error('pty runner hung'))), 30_000);
        child.on('exit', (c) => (clearTimeout(timer), resolve(c)));
      });
      expect(code).toBe(0);
      const debug = readFileSync(debugFile, 'utf8');
      const lines = debug.split('\n').filter((l) => /obsidian/i.test(l));
      console.log(`[smoke] bridge MCP requests: ${mcpRequests}\n[smoke] debug lines mentioning obsidian:\n${lines.slice(0, 15).join('\n')}`);
      expect(mcpRequests).toBeGreaterThanOrEqual(2);
      expect(debug).not.toContain(server.token);
      expect(lines.some((l) => /connected|connection established|Successfully/i.test(l))).toBe(true);
    } finally {
      server.dispose();
    }
  }, 60_000);
});
