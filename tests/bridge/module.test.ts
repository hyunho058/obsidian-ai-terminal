import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync } from 'node:fs';
import * as http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_TOKEN_ENV,
  BRIDGE_URL_ENV,
  bridgeStartFailedNotice,
  claudeMcpConfig,
  createBridgeModule,
  createClaudeMcpContributor,
} from '../../src/bridge/index';
import {
  BridgeHttpServer,
  BridgeStartAbortedError,
  NOT_IN_USE_MESSAGE,
  TOOLS_OFF_MESSAGE,
  type BridgeEndpoint,
  type BridgeServerService,
} from '../../src/bridge/httpServer';
import type { FeatureModule } from '../../src/core/types';
import type { SpawnContext } from '../../src/core/spawn';
import { Notice } from '../mocks/obsidian';
import { createBridgeEnv, startRuntime } from './helpers';

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const runtimes: Runtime[] = [];

async function load(data: unknown = null, extra: FeatureModule[] = []) {
  const env = createBridgeEnv();
  const rt = await startRuntime(env, [createBridgeModule({ debounceMs: 10 }), ...extra], data);
  runtimes.push(rt);
  return { env, ...rt };
}

/** A module that adds `GET /ping` to ctx.routes and keeps the server up while `needed()` (like snapshots do). */
function routeUser(needed: () => boolean): FeatureModule & { dispose?: () => void } {
  const mod: FeatureModule & { dispose?: () => void } = {
    id: 'route-user',
    register(ctx) {
      ctx.routes.addRoute('GET', '/ping', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
      });
      mod.dispose = ctx.services.require('bridgeServer').keepRunningWhile('ping', needed);
    },
  };
  return mod;
}

/** One request on a fresh connection (no keep-alive pool: the server is stopped and restarted in between). */
function call(url: string, init: { method?: string; token?: string; body?: string } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    const req = http.request(url, { method: init.method ?? 'POST', headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end(init.method === 'GET' ? undefined : (init.body ?? '{}'));
  });
}

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });

function spawnCtx(profile: SpawnContext['profile']): SpawnContext {
  return { profile, panelId: 'p1', vaultPath: '/vault', phase: 'new', command: profile, baseArgs: ['--model', 'sonnet'] };
}

/** True if a plain TCP connection to the port succeeds (something is bound to it). */
function tcpConnects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
  });
}

beforeEach(() => Notice.clear());
afterEach(() => {
  vi.restoreAllMocks();
  for (const rt of runtimes.splice(0)) if (!rt.ctx.unloading) rt.runtime.unload();
});

describe('bridge module', () => {
  it('provides bridgeState + bridgeServer, registers the editor extension and listens after ready', async () => {
    const { ctx, plugin } = await load();
    const server = ctx.services.require('bridgeServer');
    expect(ctx.services.has('bridgeState')).toBe(true);
    expect(server.isRunning()).toBe(true);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(plugin.editorExtensions).toHaveLength(1);
  });

  it('R9.3 end-to-end: tools read the real Obsidian state over HTTP', async () => {
    const { ctx, env } = await load();
    const x = env.addNote('Notes/X.md', 'one\ntwo\nthree');
    env.focus(x.leaf);
    x.editor.setSelection({ line: 1, ch: 0 }, { line: 2, ch: 5 });
    env.focus(env.addTerminal('right'));
    const server = ctx.services.require('bridgeServer');
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }));
    try {
      const text = async (name: string, args: Record<string, unknown> = {}) =>
        JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text);
      expect(await text('get_active_note')).toEqual({ path: 'Notes/X.md', content: 'one\ntwo\nthree', cursorLine: 3 });
      expect(await text('get_selection')).toEqual({ path: 'Notes/X.md', text: 'two\nthree', fromLine: 2, toLine: 3 });
      expect(await text('list_open_notes')).toEqual([{ path: 'Notes/X.md', active: true }]);
      expect(await text('open_note', { path: 'Notes/X.md', line: 2 })).toEqual({ opened: 'Notes/X.md', line: 2 });
      expect(env.app.openFileCalls.at(-1)!.leaf).toBe(x.leaf);
    } finally {
      await client.close();
    }
  });

  it('R11.1: Claude spawns get --mcp-config=<json> (URL + Authorization from env) and the token only in env', async () => {
    const { ctx } = await load();
    const server = ctx.services.require('bridgeServer');
    const plan = await ctx.spawn.resolve(spawnCtx('claude'));
    expect(plan.args.slice(0, 2)).toEqual(['--model', 'sonnet']);
    const flag = plan.args.find((a) => a.startsWith('--mcp-config='))!;
    expect(JSON.parse(flag.slice('--mcp-config='.length))).toEqual({
      mcpServers: { obsidian: { type: 'http', url: server.url, headers: { Authorization: 'Bearer ${OBSIDIAN_BRIDGE_TOKEN}' } } },
    });
    expect(plan.args.join(' ')).not.toContain(server.token);
    expect(plan.env).toEqual({ [BRIDGE_TOKEN_ENV]: server.token, [BRIDGE_URL_ENV]: server.baseUrl });
    for (const f of ['.claude.json', '.claude/settings.json', '.claude']) expect(existsSync(join(homedir(), f))).toBe(false);
    expect(existsSync('/vault/.mcp.json')).toBe(false);

    for (const p of ['agy', 'shell'] as const) {
      const other = await ctx.spawn.resolve(spawnCtx(p));
      expect(other.args).toEqual(['--model', 'sonnet']);
      expect(other.env).toEqual({});
    }
  });

  it('bridgeEnabled off from the start → nothing bound, no --mcp-config; on binds; off again keeps the port but refuses (deviation 20)', async () => {
    const { ctx } = await load({ bridgeEnabled: false });
    const server = ctx.services.require('bridgeServer');
    expect(server.isRunning()).toBe(false);
    expect(server.port).toBeNull();
    expect((await ctx.spawn.resolve(spawnCtx('claude'))).args).toEqual(['--model', 'sonnet']);

    ctx.settings.bridgeEnabled = true;
    await ctx.saveSettings();
    await server.whenListening();
    const port = server.port!;
    expect((await ctx.spawn.resolve(spawnCtx('claude'))).args.some((a) => a.startsWith('--mcp-config='))).toBe(true);

    ctx.settings.bridgeEnabled = false;
    await ctx.saveSettings();
    expect(server.isRunning()).toBe(true);
    expect(server.isServing()).toBe(false);
    expect(server.port).toBe(port);
    expect((await call(server.url!, { token: server.token, body: INIT })).status).toBe(403);
    expect((await ctx.spawn.resolve(spawnCtx('claude'))).env).toEqual({});
  });

  it('deviation 19: tools off but another module needs the server → it listens, serves only ctx.routes, /mcp is refused, no --mcp-config', async () => {
    let needed = true;
    const user = routeUser(() => needed);
    const { ctx } = await load({ bridgeEnabled: false }, [user]);
    const server = ctx.services.require('bridgeServer');
    expect(server.isRunning()).toBe(true);
    const base = server.baseUrl!;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // The token is still checked before routing.
    expect((await call(`${base}/ping`, { method: 'GET' })).status).toBe(401);
    expect((await call(`${base}/mcp`, { body: INIT })).status).toBe(401);
    expect(await call(`${base}/ping`, { method: 'GET', token: server.token })).toEqual({ status: 200, text: 'pong' });
    const mcp = await call(`${base}/mcp`, { token: server.token, body: INIT });
    expect(mcp.status).toBe(403);
    expect(JSON.parse(mcp.text)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: TOOLS_OFF_MESSAGE } });
    const plan = await ctx.spawn.resolve(spawnCtx('claude'));
    expect(plan.args).toEqual(['--model', 'sonnet']);
    expect(plan.env).toEqual({});

    // Turning the tools on serves /mcp on the same server (no restart); off again → refused again, server still up.
    const port = server.port;
    ctx.settings.bridgeEnabled = true;
    await ctx.saveSettings();
    expect(server.port).toBe(port);
    expect((await call(`${base}/mcp`, { token: server.token, body: INIT })).status).toBe(200);
    expect((await ctx.spawn.resolve(spawnCtx('claude'))).args.some((a) => a.startsWith('--mcp-config='))).toBe(true);
    ctx.settings.bridgeEnabled = false;
    await ctx.saveSettings();
    expect(server.isRunning()).toBe(true);
    expect((await call(`${base}/mcp`, { token: server.token, body: INIT })).status).toBe(403);

    // Deviation 20: the need goes away → the port stays bound, requests are refused; the need comes back → served again.
    needed = false;
    await ctx.saveSettings();
    expect(server.isRunning()).toBe(true);
    expect(server.isServing()).toBe(false);
    expect(server.port).toBe(port);
    const refused = await call(`${base}/ping`, { method: 'GET', token: server.token });
    expect([refused.status, JSON.parse(refused.text).error.message]).toEqual([403, NOT_IN_USE_MESSAGE]);
    needed = true;
    await ctx.saveSettings();
    expect(await call(`${base}/ping`, { method: 'GET', token: server.token })).toEqual({ status: 200, text: 'pong' });

    // Dropping the demand: still bound, refusing.
    user.dispose!();
    expect(server.isRunning()).toBe(true);
    expect(server.port).toBe(port);
    expect((await call(`${base}/ping`, { method: 'GET', token: server.token })).status).toBe(403);
  });

  it('deviation 20: tools + snapshots off with the server running → port kept (401 without token, refusal with it); back on → same port and token, a stale-env client works again', async () => {
    let snapshots = true;
    const { ctx } = await load(null, [routeUser(() => snapshots)]);
    const server = ctx.services.require('bridgeServer');
    // What a running Claude panel got at spawn time.
    const plan = await ctx.spawn.resolve(spawnCtx('claude'));
    const staleBase = plan.env[BRIDGE_URL_ENV]!;
    const staleToken = plan.env[BRIDGE_TOKEN_ENV]!;
    const port = server.port!;
    const client = new Client({ name: 'stale', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${staleBase}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${staleToken}` } } }));
    try {
      expect((await client.listTools()).tools).toHaveLength(5);

      ctx.settings.bridgeEnabled = false;
      snapshots = false;
      await ctx.saveSettings();
      expect(server.isServing()).toBe(false);
      expect(server.isRunning()).toBe(true);
      expect(await tcpConnects(port)).toBe(true);
      for (const path of ['/mcp', '/ping']) expect((await call(`${staleBase}${path}`, { body: INIT })).status).toBe(401);
      const mcp = await call(`${staleBase}/mcp`, { token: staleToken, body: INIT });
      expect([mcp.status, JSON.parse(mcp.text).error.message]).toEqual([403, TOOLS_OFF_MESSAGE]);
      const ping = await call(`${staleBase}/ping`, { method: 'GET', token: staleToken });
      expect([ping.status, JSON.parse(ping.text).error.message]).toEqual([403, NOT_IN_USE_MESSAGE]);
      await expect(client.listTools()).rejects.toThrow(/turned off/);

      ctx.settings.bridgeEnabled = true;
      snapshots = true;
      await ctx.saveSettings();
      expect(server.port).toBe(port);
      expect(server.token).toBe(staleToken);
      expect(server.baseUrl).toBe(staleBase);
      expect((await client.listTools()).tools).toHaveLength(5); // same client, no respawn
      expect(await call(`${staleBase}/ping`, { method: 'GET', token: staleToken })).toEqual({ status: 200, text: 'pong' });
    } finally {
      await client.close();
    }
  });

  it('deviation 19: tools off and no module needs the server → nothing listens', async () => {
    const { ctx } = await load({ bridgeEnabled: false }, [routeUser(() => false)]);
    const server = ctx.services.require('bridgeServer');
    expect(server.isRunning()).toBe(false);
    expect(server.baseUrl).toBeNull();
    await expect(server.whenListening()).rejects.toThrow();
  });

  it('tools on: a demand that is not needed changes nothing (server up, /mcp served)', async () => {
    const { ctx } = await load(null, [routeUser(() => false)]);
    const server = ctx.services.require('bridgeServer');
    expect(server.isRunning()).toBe(true);
    expect((await call(server.url!, { token: server.token, body: INIT })).status).toBe(200);
  });

  it('R9.5: unload closes the port synchronously', async () => {
    const { ctx, runtime } = await load();
    const server = ctx.services.require('bridgeServer') as BridgeServerService;
    const port = server.port!;
    runtime.unload();
    expect(server.isRunning()).toBe(false);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }).then(
      () => 'answered',
      () => 'refused',
    );
    expect(res).toBe('refused');
  });

  it('R9.5 / deviation 20: unload also closes a port that is kept while not in use', async () => {
    const { ctx, runtime } = await load();
    const server = ctx.services.require('bridgeServer');
    const port = server.port!;
    ctx.settings.bridgeEnabled = false;
    await ctx.saveSettings();
    expect(await tcpConnects(port)).toBe(true);
    runtime.unload();
    expect(server.isRunning()).toBe(false);
    expect(await tcpConnects(port)).toBe(false);
  });

  it('start failure: one Notice naming everything lost (tools and snapshots); an aborted start stays quiet', async () => {
    const start = vi.spyOn(BridgeHttpServer.prototype, 'start').mockRejectedValue(new Error('listen EACCES'));
    const both = await load(null, [routeUser(() => true)]);
    expect(both.ctx.services.require('bridgeServer').isRunning()).toBe(false);
    const message = 'AI Terminal: the bridge server could not start, so AI tools cannot see your notes and Claude Code messages are not snapshotted. Reload the plugin to try again.';
    expect(bridgeStartFailedNotice(['AI tools cannot see your notes', 'Claude Code messages are not snapshotted'])).toBe(message);
    // routeUser's reason is "ping"; the snapshot module's is "snapshots".
    expect(Notice.shown.map((n) => n.message)).toEqual([
      'AI Terminal: the bridge server could not start, so AI tools cannot see your notes and ping cannot use it. Reload the plugin to try again.',
    ]);
    Notice.clear();
    const snapshotsOnly: FeatureModule = {
      id: 'snapshots-like',
      register(ctx) {
        ctx.onUnload(ctx.services.require('bridgeServer').keepRunningWhile('snapshots', () => true));
      },
    };
    await load(null, [snapshotsOnly]);
    expect(Notice.shown.map((n) => n.message)).toEqual([message]);
    Notice.clear();
    await load({ bridgeEnabled: false }, [snapshotsOnly]);
    expect(Notice.shown.map((n) => n.message)).toEqual([
      'AI Terminal: the bridge server could not start, so Claude Code messages are not snapshotted. Reload the plugin to try again.',
    ]);

    Notice.clear();
    start.mockRejectedValue(new BridgeStartAbortedError());
    const aborted = await load();
    expect(aborted.ctx.unloading).toBe(false);
    expect(Notice.shown).toEqual([]);
    expect(aborted.out.lines.some((l) => l.includes('could not start'))).toBe(false);
  });

  it('R9.4: two plugin instances (vaults) get different ports and tokens', async () => {
    const a = await load();
    const b = await load();
    const sa = a.ctx.services.require('bridgeServer');
    const sb = b.ctx.services.require('bridgeServer');
    expect(sa.port).not.toBe(sb.port);
    expect(sa.token).not.toBe(sb.token);
    const pa = await a.ctx.spawn.resolve(spawnCtx('claude'));
    expect(pa.args.join(' ')).toContain(sa.url!);
    expect(pa.args.join(' ')).not.toContain(sb.url!);
  });
});

describe('claude MCP contributor', () => {
  it('waits briefly for a server that is still starting, skips a stopped one', async () => {
    let running = false;
    let release!: () => void;
    const listening = new Promise<void>((r) => (release = r));
    const fake: BridgeEndpoint = {
      get url() {
        return running ? 'http://127.0.0.1:9/mcp' : null;
      },
      get baseUrl() {
        return running ? 'http://127.0.0.1:9' : null;
      },
      get port() {
        return running ? 9 : null;
      },
      token: 'tok-123456',
      whenListening: () => listening,
      isRunning: () => running,
    };
    const contribute = createClaudeMcpContributor(() => fake);
    const pending = contribute(spawnCtx('claude'));
    running = true;
    release();
    expect(await pending).toEqual({ args: [`--mcp-config=${claudeMcpConfig('http://127.0.0.1:9/mcp')}`], env: { OBSIDIAN_BRIDGE_TOKEN: 'tok-123456', OBSIDIAN_BRIDGE_URL: 'http://127.0.0.1:9' } });

    const stopped = createClaudeMcpContributor(() => ({ ...fake, isRunning: () => false, whenListening: () => Promise.reject(new Error('off')) }));
    expect(await stopped(spawnCtx('claude'))).toBeUndefined();
    expect(await createClaudeMcpContributor(() => undefined)(spawnCtx('claude'))).toBeUndefined();
  });
});
