import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRIDGE_TOKEN_ENV, createBridgeModule } from '../../src/bridge/index';
import { createIdeModule, ideLockDir, isPidAlive, type IdeModuleOptions } from '../../src/bridge/ideModule';
import type { BridgeState } from '../../src/bridge/state';
import type { SpawnContext } from '../../src/core/spawn';
import { createBridgeEnv, startRuntime } from '../bridge/helpers';
import { connect, sleep, type IdeTestClient } from './helpers';

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const runtimes: Runtime[] = [];
const clients: IdeTestClient[] = [];

async function load(data: unknown = null, options: IdeModuleOptions = {}) {
  const env = createBridgeEnv();
  const rt = await startRuntime(env, [createBridgeModule({ debounceMs: 10 }), createIdeModule({ seedDelaysMs: [], ...options })], data);
  runtimes.push(rt);
  return { env, ...rt, ide: rt.ctx.services.require('ide') };
}

async function claudeClient(port: number, token: string) {
  const r = await connect(port, token);
  if (!r.ok) throw new Error(r.error);
  clients.push(r.client);
  await r.client.handshake();
  return r.client;
}

function spawnCtx(profile: SpawnContext['profile']): SpawnContext {
  return { profile, panelId: 'p1', vaultPath: '/vault', phase: 'new', command: profile, baseArgs: [] };
}

function lockFiles(): string[] {
  const dir = ideLockDir();
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.lock')).sort() : [];
}

beforeEach(() => rmSync(ideLockDir(), { recursive: true, force: true }));

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const rt of runtimes.splice(0)) if (!rt.ctx.unloading) rt.runtime.unload();
});

describe('ide module', () => {
  it('R10.1: after ready, ~/.claude/ide/<port>.lock exists (0600) with pid, vault, ideName, transport, authToken', async () => {
    const { ide } = await load();
    expect(ide.isRunning()).toBe(true);
    const file = join(homedir(), '.claude', 'ide', `${ide.port}.lock`);
    expect(ide.lockFilePath).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    expect(lock).toEqual({ pid: process.pid, workspaceFolders: ['/vault'], ideName: 'Obsidian', transport: 'ws', authToken: expect.any(String) });
    expect(lock.authToken.length).toBeGreaterThanOrEqual(32);
  });

  it('R10.2: the lock file token is required to connect', async () => {
    const { ide } = await load();
    const { authToken } = JSON.parse(readFileSync(ide.lockFilePath!, 'utf8'));
    expect(await connect(ide.port!, null)).toMatchObject({ ok: false, status: 401 });
    expect(await connect(ide.port!, 'x'.repeat(36))).toMatchObject({ ok: false, status: 401 });
    const c = await claudeClient(ide.port!, authToken);
    expect((await c.request('tools/list')).result).toEqual({ tools: [] });
    await sleep(10);
    expect(ide.clientCount()).toBe(1);
  });

  it('R11.1 / R10.3: Claude spawns get --ide + CLAUDE_CODE_SSE_PORT next to --mcp-config; Claude config files untouched', async () => {
    const { ctx, ide } = await load();
    const plan = await ctx.spawn.resolve(spawnCtx('claude'));
    expect(plan.args.some((a) => a.startsWith('--mcp-config='))).toBe(true);
    expect(plan.args.filter((a) => a === '--ide')).toHaveLength(1);
    expect(plan.env.CLAUDE_CODE_SSE_PORT).toBe(String(ide.port));
    expect(plan.env[BRIDGE_TOKEN_ENV]).toBeTruthy();
    expect(plan.args.join(' ')).not.toContain(JSON.parse(readFileSync(ide.lockFilePath!, 'utf8')).authToken);
    for (const f of ['.claude.json', '.claude/settings.json']) expect(existsSync(join(homedir(), f))).toBe(false);
    for (const p of ['agy', 'shell'] as const) {
      const other = await ctx.spawn.resolve(spawnCtx(p));
      expect(other.args).not.toContain('--ide');
      expect(other.env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    }
  });

  it('R10.4 / R10.5 end-to-end: note selection → selection_changed (absolute path); focusing a terminal sends nothing', async () => {
    const { ctx, env, ide } = await load();
    const state = ctx.services.require('bridgeState') as BridgeState;
    const { authToken } = JSON.parse(readFileSync(ide.lockFilePath!, 'utf8'));
    const c = await claudeClient(ide.port!, authToken);
    await sleep(20);

    const x = env.addNote('Notes/X.md', 'one\ntwo\nthree\nfour\nfive');
    env.focus(x.leaf);
    x.editor.setSelection({ line: 1, ch: 0 }, { line: 4, ch: 0 }); // 3 lines: two, three, four
    state.editorActivity();
    const msg = await c.next((m) => m.method === 'selection_changed' && m.params.selection.isEmpty === false);
    expect(msg.params).toEqual({
      text: 'two\nthree\nfour\n',
      filePath: '/vault/Notes/X.md',
      fileUrl: 'file:///vault/Notes/X.md',
      selection: { start: { line: 1, character: 0 }, end: { line: 4, character: 0 }, isEmpty: false },
    });
    await sleep(40);
    const count = c.selections().length;

    env.focus(env.addTerminal('right'));
    await sleep(100);
    expect(c.selections()).toHaveLength(count);
  });

  it('R10.9: unload removes the lock file synchronously and closes the port', async () => {
    const { runtime, ide } = await load();
    const file = ide.lockFilePath!;
    const port = ide.port!;
    runtime.unload();
    expect(existsSync(file)).toBe(false);
    expect(lockFiles()).toEqual([]);
    expect(await connect(port, 'whatever-token-123')).toMatchObject({ ok: false });
  });

  it('a window reload / quit (pagehide) removes the lock file synchronously even if plugin unload never runs', async () => {
    const target = new EventTarget();
    const { ide } = await load(null, { windowTarget: target });
    const file = ide.lockFilePath!;
    target.dispatchEvent(new Event('pagehide'));
    expect(existsSync(file)).toBe(false);
    expect(ide.isRunning()).toBe(false);
  });

  it('R10.10: with ideConnectionEnabled = false there is no server or lock file, no --ide / SSE port, and the HTTP tools still work', async () => {
    const { ctx, env, ide } = await load({ ideConnectionEnabled: false });
    expect(ide.isRunning()).toBe(false);
    expect(ide.port).toBeNull();
    expect(lockFiles()).toEqual([]);
    const plan = await ctx.spawn.resolve(spawnCtx('claude'));
    expect(plan.args).not.toContain('--ide');
    expect(plan.env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(plan.args.some((a) => a.startsWith('--mcp-config='))).toBe(true);
    const server = ctx.services.require('bridgeServer');
    expect(server.isRunning()).toBe(true);

    // The D24 tools over HTTP, as Claude's MCP client calls them (bearer token from the panel environment).
    const x = env.addNote('Notes/X.md', 'one\ntwo\nthree');
    env.focus(x.leaf);
    x.editor.setSelection({ line: 1, ch: 0 }, { line: 1, ch: 3 });
    const client = new Client({ name: 'claude-code', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: { Authorization: `Bearer ${plan.env[BRIDGE_TOKEN_ENV]}` } } }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['get_active_note', 'get_links', 'get_selection', 'list_open_notes', 'open_note']);
      const active = await client.callTool({ name: 'get_active_note', arguments: {} });
      expect(active.isError).toBeFalsy();
      expect(JSON.parse((active.content as Array<{ text: string }>)[0]!.text)).toEqual({ path: 'Notes/X.md', content: 'one\ntwo\nthree', cursorLine: 2 });
      const selection = await client.callTool({ name: 'get_selection', arguments: {} });
      expect(JSON.parse((selection.content as Array<{ text: string }>)[0]!.text)).toEqual({ path: 'Notes/X.md', text: 'two', fromLine: 2, toLine: 2 });
    } finally {
      await client.close();
    }
    // Still no IDE server or lock file after the tool calls.
    expect(ide.isRunning()).toBe(false);
    expect(lockFiles()).toEqual([]);
  });

  it('settings toggle: off → server closed, lock removed, contributor silent, bridge untouched; on → back with a new lock file', async () => {
    const { ctx, ide } = await load();
    const firstLock = ide.lockFilePath!;
    const { authToken } = JSON.parse(readFileSync(firstLock, 'utf8'));
    const c = await claudeClient(ide.port!, authToken);
    const closed = new Promise<void>((r) => c.ws.once('close', () => r()));

    ctx.settings.ideConnectionEnabled = false;
    await ctx.saveSettings();
    expect(ide.isRunning()).toBe(false);
    expect(existsSync(firstLock)).toBe(false);
    await closed;
    let plan = await ctx.spawn.resolve(spawnCtx('claude'));
    expect(plan.args).not.toContain('--ide');
    expect(plan.env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(ctx.services.require('bridgeServer').isRunning()).toBe(true);

    ctx.settings.ideConnectionEnabled = true;
    await ctx.saveSettings();
    await ide.whenListening();
    expect(ide.isRunning()).toBe(true);
    expect(lockFiles()).toEqual([`${ide.port}.lock`]);
    plan = await ctx.spawn.resolve(spawnCtx('claude'));
    expect(plan.args).toContain('--ide');
    expect(plan.env.CLAUDE_CODE_SSE_PORT).toBe(String(ide.port));
    const again = await connect(ide.port!, authToken); // same token for the whole plugin load
    expect(again.ok).toBe(true);
    if (again.ok) clients.push(again.client);
  });

  it('toggling off while starting leaves nothing behind', async () => {
    const { ctx, ide } = await load({ ideConnectionEnabled: false });
    ctx.settings.ideConnectionEnabled = true;
    await ctx.saveSettings();
    ctx.settings.ideConnectionEnabled = false;
    await ctx.saveSettings();
    await sleep(50);
    expect(ide.isRunning()).toBe(false);
    expect(lockFiles()).toEqual([]);
  });

  it('R10.7: on load, stale Obsidian lock files are deleted; live ones, other IDEs and garbage stay unchanged', async () => {
    const dir = ideLockDir();
    mkdirSync(dir, { recursive: true });
    const files: Record<string, string> = {
      '50001.lock': JSON.stringify({ pid: 900001, workspaceFolders: ['/old'], ideName: 'Obsidian', transport: 'ws', authToken: 'a' }),
      '50002.lock': JSON.stringify({ pid: process.pid, workspaceFolders: ['/other-vault'], ideName: 'Obsidian', transport: 'ws', authToken: 'b' }),
      '50003.lock': JSON.stringify({ pid: 900001, workspaceFolders: ['/x'], ideName: 'Visual Studio Code', transport: 'ws', authToken: 'c' }),
      '50004.lock': 'garbage',
    };
    for (const [n, content] of Object.entries(files)) writeFileSync(join(dir, n), content, { mode: 0o600 });
    const { ide } = await load(null, { isPidAlive: (pid) => pid !== 900001 && isPidAlive(pid) });
    expect(existsSync(join(dir, '50001.lock'))).toBe(false);
    for (const n of ['50002.lock', '50003.lock', '50004.lock']) expect(readFileSync(join(dir, n), 'utf8')).toBe(files[n]);
    expect(lockFiles()).toEqual(['50002.lock', '50003.lock', '50004.lock', `${ide.port}.lock`].sort());
  });

  it('stale cleanup also runs when the IDE connection is off', async () => {
    const dir = ideLockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '50005.lock'), JSON.stringify({ pid: 999_999, workspaceFolders: ['/old'], ideName: 'Obsidian', transport: 'ws', authToken: 'a' }));
    await load({ ideConnectionEnabled: false });
    expect(lockFiles()).toEqual([]);
  });
});
