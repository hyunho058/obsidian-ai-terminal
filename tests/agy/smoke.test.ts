// Opt-in: AI_TERMINAL_SMOKE=1 npx vitest run tests/agy/smoke.test.ts
// Uses the REAL `agy` with the temp HOME from tests/setup.ts (its config lives at $HOME/.gemini/config/mcp_config.json,
// verified with agy 1.3.0), so the user's real config is never read or written. Covers add / list / remove through
// AgyConfig, then starts agy in a PTY for at most 8 s (typing nothing) to see it reach a bridge through the shim.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgyConfig, parseMcpList, runCommand, type AgyRunner } from '../../src/bridge/agyConfig';
import { spawnPty } from '../../src/pty/PtyProcess';
import { HELPER_SOURCE } from '../pty/helpers';
import { DUMMY_SECRET, secretConfig } from './fakeAgy';
import { SHIM_SOURCE, waitFor } from './helpers';

const SMOKE = process.env.AI_TERMINAL_SMOKE === '1';
const AGY = join(userInfo().homedir, '.local', 'bin', 'agy');
const PY = existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : '/usr/bin/python3';

/** Environment for real agy: temp HOME / XDG only (never the user's). */
function isolatedEnv(): Record<string, string> {
  const home = homedir();
  if (home === userInfo().homedir) throw new Error('refusing to run: HOME is the real home directory');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !/^(ANTIGRAVITY_|GEMINI_|OBSIDIAN_BRIDGE_)/.test(k)) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
  };
}

function agy(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(AGY, args, { env: isolatedEnv(), cwd: homedir(), encoding: 'utf8', timeout: 15_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!SMOKE || !existsSync(AGY))('smoke: real agy under a temp HOME', () => {
  it('add / list / remove through AgyConfig; other entries keep their values', async () => {
    // Guard: the temp HOME starts empty, so we are not looking at the real config.
    expect(agy('mcp', 'list').out.trim()).toBe('No MCP servers configured.');
    const cfgPath = join(homedir(), '.gemini', 'config', 'mcp_config.json');
    mkdirSync(join(homedir(), '.gemini', 'config'), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(secretConfig(), null, 2));
    const others = () => {
      const servers = JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers as Record<string, Record<string, unknown>>;
      const { obsidian: _, ...rest } = servers;
      return rest;
    };
    const before = others();

    const shim = join(homedir(), '.config', 'obsidian-ai-terminal', 'mcp_shim.py');
    mkdirSync(join(homedir(), '.config', 'obsidian-ai-terminal'), { recursive: true });
    copyFileSync(SHIM_SOURCE, shim);
    const adds: string[][] = [];
    const counting: AgyRunner = (file, args, opts) => {
      if (args[1] === 'add') adds.push([...args]);
      return runCommand(file, args, opts);
    };
    const make = () => new AgyConfig({ getCommand: () => AGY, getEnv: isolatedEnv, run: counting });

    const [a, b] = [make(), make()];
    const outcomes = await Promise.all([a.ensureEntry(PY, shim), b.ensureEntry(PY, shim)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['added', 'unchanged']);
    expect(adds).toEqual([['mcp', 'add', 'obsidian', '--', PY, '-I', shim]]);
    const listed = parseMcpList(agy('mcp', 'list').out)!;
    expect(listed.find((e) => e.name === 'obsidian')).toEqual({ name: 'obsidian', type: 'stdio', status: 'enabled', command: `${PY} -I ${shim}` });
    expect(others()).toEqual(before);
    expect(readFileSync(cfgPath, 'utf8')).toContain(DUMMY_SECRET);

    expect(await a.ensureEntry(PY, shim)).toEqual({ status: 'unchanged' });
    expect(adds).toHaveLength(1);

    expect(await a.removeEntry()).toEqual({ status: 'removed' });
    expect(parseMcpList(agy('mcp', 'list').out)!.map((e) => e.name)).toEqual(['context7', 'remote']);
    expect(others()).toEqual(before);
    expect(await a.removeEntry()).toEqual({ status: 'absent' });
    console.log(`smoke agy: ${agy('--version').out.trim()} — add/list/remove OK, other entries unchanged`);
  }, 60_000);

  it('agy started with the bridge variables reaches the bridge through the shim (≤ 8 s, typing nothing)', async () => {
    const token = 'smoke-token-0123456789abcdef';
    const seen: Array<{ method: string; auth: boolean }> = [];
    const server = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number | string; method?: string; params?: { protocolVersion?: string } };
        seen.push({ method: msg.method ?? '(response)', auth: req.headers.authorization === `Bearer ${token}` });
        res.setHeader('Content-Type', 'application/json');
        if (msg.id === undefined) return void res.writeHead(202).end();
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bridge', version: '1' } }
            : msg.method === 'tools/list'
              ? { tools: [] }
              : undefined;
        res.end(JSON.stringify(result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const shim = join(homedir(), '.config', 'obsidian-ai-terminal', 'mcp_shim.py');
      mkdirSync(join(homedir(), '.config', 'obsidian-ai-terminal'), { recursive: true });
      copyFileSync(SHIM_SOURCE, shim);
      expect(await new AgyConfig({ getCommand: () => AGY, getEnv: isolatedEnv }).ensureEntry(PY, shim)).toMatchObject({ status: expect.stringMatching(/added|unchanged/) });
      const cwd = mkdtempSync(join(tmpdir(), 'smoke-agy-'));
      const proc = spawnPty({
        python: PY,
        helperPath: HELPER_SOURCE,
        command: AGY,
        cwd,
        env: { ...isolatedEnv(), PWD: cwd, TERM: 'xterm-256color', OBSIDIAN_BRIDGE_URL: `http://127.0.0.1:${port}`, OBSIDIAN_BRIDGE_TOKEN: token },
        cols: 120,
        rows: 40,
      });
      const t0 = Date.now();
      await waitFor(() => seen.some((s) => s.method === 'tools/list'), 7_000).catch(() => undefined);
      proc.kill('smoke test done');
      await proc.exited;
      console.log(`smoke agy → shim → bridge in ${Date.now() - t0} ms: ${JSON.stringify(seen)}`);
      expect(seen.map((s) => s.method)).toEqual(expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list']));
      expect(seen.every((s) => s.auth)).toBe(true);
    } finally {
      server.close();
    }
  }, 30_000);
});
