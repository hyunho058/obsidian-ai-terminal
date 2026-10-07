import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, claudeMcpConfig, createBridgeModule, createClaudeMcpContributor } from '../../src/bridge/index';
import type { BridgeServerService } from '../../src/bridge/httpServer';
import type { SpawnContext } from '../../src/core/spawn';
import { createBridgeEnv, startRuntime } from './helpers';

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const runtimes: Runtime[] = [];

async function load(data: unknown = null) {
  const env = createBridgeEnv();
  const rt = await startRuntime(env, [createBridgeModule({ debounceMs: 10 })], data);
  runtimes.push(rt);
  return { env, ...rt };
}

function spawnCtx(profile: SpawnContext['profile']): SpawnContext {
  return { profile, panelId: 'p1', vaultPath: '/vault', phase: 'new', command: profile, baseArgs: ['--model', 'sonnet'] };
}

afterEach(() => {
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

  it('bridgeEnabled off → no server and no --mcp-config; toggling starts / stops it', async () => {
    const { ctx } = await load({ bridgeEnabled: false });
    const server = ctx.services.require('bridgeServer');
    expect(server.isRunning()).toBe(false);
    expect((await ctx.spawn.resolve(spawnCtx('claude'))).args).toEqual(['--model', 'sonnet']);

    ctx.settings.bridgeEnabled = true;
    await ctx.saveSettings();
    await server.whenListening();
    expect((await ctx.spawn.resolve(spawnCtx('claude'))).args.some((a) => a.startsWith('--mcp-config='))).toBe(true);

    ctx.settings.bridgeEnabled = false;
    await ctx.saveSettings();
    expect(server.isRunning()).toBe(false);
    expect((await ctx.spawn.resolve(spawnCtx('claude'))).env).toEqual({});
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
    const fake: BridgeServerService = {
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
