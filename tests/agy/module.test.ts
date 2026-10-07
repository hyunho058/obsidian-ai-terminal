import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgyModule, type AgyModuleOptions } from '../../src/bridge/agyModule';
import { AGY_LOCK_FILE } from '../../src/bridge/agyConfig';
import { createAgyEnvContributor } from '../../src/bridge/agyEnvContributor';
import type { BridgeServerService } from '../../src/bridge/httpServer';
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, createBridgeModule } from '../../src/bridge/index';
import type { SpawnContext } from '../../src/core/spawn';
import { supportDir } from '../../src/support/installScripts';
import { Notice } from '../mocks/obsidian';
import { DUMMY_SECRET, createFakeAgy, secretConfig, type FakeAgy } from './fakeAgy';
import { SHIM_SOURCE, startAgyRuntime, stubPythonModule, waitFor } from './helpers';

const PY = '/usr/bin/python3';
type Started = Awaited<ReturnType<typeof startAgyRuntime>>;
const started: Started[] = [];

beforeEach(() => {
  rmSync(join(homedir(), '.gemini'), { recursive: true, force: true });
  rmSync(join(supportDir(), AGY_LOCK_FILE), { force: true });
  Notice.clear();
});

afterEach(() => {
  for (const s of started.splice(0)) if (!s.ctx.unloading) s.runtime.unload();
});

function newFake(): FakeAgy {
  return createFakeAgy(mkdtempSync(join(tmpdir(), 'fake-agy-')));
}

async function load(fake: FakeAgy | null, data: Record<string, unknown> = {}, opts: AgyModuleOptions & { bridge?: boolean } = {}) {
  const settings = { profiles: { agy: { command: fake ? fake.path : '/nonexistent/agy', args: '' } }, ...data };
  const modules = [stubPythonModule(PY), ...(opts.bridge ? [createBridgeModule()] : []), createAgyModule(opts)];
  const s = await startAgyRuntime(modules, settings);
  started.push(s);
  return s;
}

function spawnCtx(profile: SpawnContext['profile']): SpawnContext {
  return { profile, panelId: 'p1', vaultPath: '/vault', phase: 'new', command: profile, baseArgs: [] };
}

const shimPath = (): string => join(homedir(), '.config', 'obsidian-ai-terminal', 'mcp_shim.py');

describe('agy module', () => {
  it('registers the shim, the env contributor and the agyBridge service', async () => {
    const { ctx } = await load(newFake(), {}, { bridge: true });
    expect(ctx.supportScripts.registered()).toContain('mcp_shim.py');
    expect(ctx.spawn.names()).toEqual(['bridge:claude-mcp-config', 'agy:bridge-env']);
    expect(ctx.services.require('agyBridge').shimPath).toBe(shimPath());
  });

  it('R11.3 + R11.9: on load the shim is installed to its stable path and the entry is added with absolute paths', async () => {
    const fake = newFake();
    const original = fake.writeConfig(secretConfig());
    const { ctx } = await load(fake);
    expect(readFileSync(shimPath(), 'utf8')).toBe(readFileSync(SHIM_SOURCE, 'utf8'));
    expect(fake.mcpCalls()).toEqual([
      ['mcp', 'list'],
      ['mcp', 'add', 'obsidian', '--', PY, shimPath()],
    ]);
    expect(ctx.services.require('agyBridge').lastOutcome).toEqual({ status: 'added' });
    const cfg = fake.readConfig()!;
    expect(cfg.mcpServers.context7).toEqual(secretConfig().mcpServers.context7);
    expect(cfg.mcpServers.remote).toEqual(secretConfig().mcpServers.remote);
    expect(original).toContain(DUMMY_SECRET);
    expect(existsSync(join(supportDir(), AGY_LOCK_FILE))).toBe(false);
  });

  it('R11.4: a second load with the entry in place runs no add', async () => {
    const fake = newFake();
    await load(fake);
    const s2 = await load(fake);
    expect(fake.mcpCalls('add')).toHaveLength(1);
    expect(fake.mcpCalls('list')).toHaveLength(2);
    expect(s2.ctx.services.require('agyBridge').lastOutcome).toEqual({ status: 'unchanged' });
  });

  it('R11.5: two vault windows loading at once leave one entry and run one add', async () => {
    const fake = newFake();
    fake.writeConfig(secretConfig());
    fake.control({ delayMs: 200 });
    await Promise.all([load(fake), load(fake)]);
    expect(fake.mcpCalls('add')).toHaveLength(1);
    expect(fake.calls().some((c) => c.concurrent)).toBe(false);
    expect(Object.keys(fake.readConfig()!.mcpServers).sort()).toEqual(['context7', 'obsidian', 'remote']);
  });

  it('R11.8: turning agyBridgeEnabled off removes the entry; turning it on adds it again', async () => {
    const fake = newFake();
    const original = fake.writeConfig(secretConfig());
    const { ctx, store } = await load(fake);
    expect(fake.readConfig()!.mcpServers.obsidian).toBeDefined();
    store.settings.agyBridgeEnabled = false;
    await ctx.saveSettings();
    await waitFor(() => fake.mcpCalls('remove').length === 1);
    await waitFor(() => ctx.services.require('agyBridge').lastOutcome?.status === 'removed');
    expect(fake.readConfigRaw()).toBe(original);
    expect(fake.mcpCalls('remove')).toEqual([['mcp', 'remove', 'obsidian']]);
    store.settings.agyBridgeEnabled = true;
    await ctx.saveSettings();
    await waitFor(() => ctx.services.require('agyBridge').lastOutcome?.status === 'added');
    expect(fake.mcpCalls('add')).toHaveLength(2);
    expect(Notice.shown).toEqual([]);
  });

  it('turning the bridge off while the load-time check is still preparing leaves no entry', async () => {
    const fake = newFake();
    const settings = { profiles: { agy: { command: fake.path, args: '' } } };
    const s = await startAgyRuntime([stubPythonModule(PY, 200), createAgyModule()], settings, undefined, false);
    started.push(s);
    s.store.settings.agyBridgeEnabled = false;
    await s.ctx.saveSettings();
    await s.ctx.ready;
    await waitFor(() => s.ctx.services.require('agyBridge').lastOutcome?.status === 'skipped');
    expect(fake.mcpCalls('add')).toEqual([]);
    expect(fake.readConfig()?.mcpServers.obsidian).toBeUndefined();
    expect(Notice.shown).toEqual([]);
  });

  it('does nothing at load when agyBridgeEnabled is off', async () => {
    const fake = newFake();
    const { ctx } = await load(fake, { agyBridgeEnabled: false });
    expect(fake.calls()).toEqual([]);
    expect(ctx.services.require('agyBridge').lastOutcome).toBeUndefined();
    expect(existsSync(shimPath())).toBe(true); // the shim is still installed (R11.9)
  });

  it('a missing agy is logged and skipped — the plugin loads, no Notice', async () => {
    const { ctx, out } = await load(null);
    expect(ctx.isReady()).toBe(true);
    expect(ctx.services.require('agyBridge').lastOutcome).toEqual({ status: 'skipped', reason: 'agy not found' });
    expect(Notice.shown).toEqual([]);
    expect(out.lines.some((l) => l.includes('agy ensure skipped: agy not found'))).toBe(true);
  });

  it('turning the agy bridge on with agy missing shows a Notice', async () => {
    const { ctx, store } = await load(null, { agyBridgeEnabled: false });
    store.settings.agyBridgeEnabled = true;
    await ctx.saveSettings();
    await waitFor(() => Notice.shown.length === 1);
    expect(Notice.shown[0]!.message).toContain('Antigravity CLI (agy) was not found');
  });

  it('a foreign `obsidian` entry is left alone with a Notice', async () => {
    const fake = newFake();
    const raw = fake.writeConfig({ mcpServers: { obsidian: { serverUrl: 'http://127.0.0.1:27123/mcp' } } });
    await load(fake);
    expect(fake.mcpCalls('add')).toEqual([]);
    expect(fake.readConfigRaw()).toBe(raw);
    expect(Notice.shown).toHaveLength(1);
    expect(Notice.shown[0]!.message).toContain('agy mcp remove obsidian');
  });

  it('the ready gate is bounded even if agy hangs', async () => {
    const fake = newFake();
    fake.control({ hang: ['list'] });
    const t0 = Date.now();
    const { ctx } = await load(fake, {}, { readyTimeoutMs: 300, listTimeoutMs: 1500 });
    expect(Date.now() - t0).toBeLessThan(1400);
    expect(ctx.isReady()).toBe(true);
    await waitFor(() => ctx.services.require('agyBridge').lastOutcome?.status === 'failed', 5000);
  });

  it('re-checks the entry (debounced) when the Python path changes', async () => {
    const fake = newFake();
    const { ctx, store } = await load(fake, {}, { recheckDelayMs: 50 });
    for (const p of ['/u', '/us', '/usr/bin/python3']) {
      store.settings.pythonPath = p;
      await ctx.saveSettings();
    }
    await waitFor(() => fake.mcpCalls('list').length === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.mcpCalls('list')).toHaveLength(2);
  });

  it('unload releases the lock synchronously', async () => {
    const fake = newFake();
    fake.control({ delayMs: 400 });
    const { ctx, runtime } = await load(fake, {}, { readyTimeoutMs: 50 });
    expect(existsSync(join(supportDir(), AGY_LOCK_FILE))).toBe(true);
    runtime.unload();
    expect(existsSync(join(supportDir(), AGY_LOCK_FILE))).toBe(false);
    expect(ctx.unloading).toBe(true);
  });
});

describe('agy env contributor', () => {
  const server = (over: Partial<BridgeServerService> = {}): BridgeServerService => ({
    url: 'http://127.0.0.1:4321/mcp',
    baseUrl: 'http://127.0.0.1:4321',
    port: 4321,
    token: 'tok-abcdef-123456',
    whenListening: () => Promise.resolve(),
    isRunning: () => true,
    ...over,
  });

  it('gives agy panels OBSIDIAN_BRIDGE_URL (base URL) and OBSIDIAN_BRIDGE_TOKEN — nothing else', async () => {
    const c = createAgyEnvContributor({ getServer: () => server(), enabled: () => true });
    expect(await c(spawnCtx('agy'))).toEqual({ env: { OBSIDIAN_BRIDGE_URL: 'http://127.0.0.1:4321', OBSIDIAN_BRIDGE_TOKEN: 'tok-abcdef-123456' } });
    expect(await c(spawnCtx('claude'))).toBeUndefined();
    expect(await c(spawnCtx('shell'))).toBeUndefined();
  });

  it('contributes nothing when disabled, without a server, or when the server does not come up', async () => {
    expect(await createAgyEnvContributor({ getServer: () => server(), enabled: () => false })(spawnCtx('agy'))).toBeUndefined();
    expect(await createAgyEnvContributor({ getServer: () => undefined, enabled: () => true })(spawnCtx('agy'))).toBeUndefined();
    const down = server({ isRunning: () => false, whenListening: () => Promise.reject(new Error('stopped')), baseUrl: null });
    expect(await createAgyEnvContributor({ getServer: () => down, enabled: () => true })(spawnCtx('agy'))).toBeUndefined();
    const slow = server({ isRunning: () => false, whenListening: () => new Promise(() => {}) });
    const t0 = Date.now();
    expect(await createAgyEnvContributor({ getServer: () => slow, enabled: () => true, startWaitMs: 100 })(spawnCtx('agy'))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('waits for a server that is still starting', async () => {
    let running = false;
    const starting = server({ isRunning: () => running, whenListening: () => new Promise((r) => setTimeout(() => ((running = true), r()), 50)) });
    const env = await createAgyEnvContributor({ getServer: () => starting, enabled: () => true })(spawnCtx('agy'));
    expect(env).toEqual({ env: { OBSIDIAN_BRIDGE_URL: 'http://127.0.0.1:4321', OBSIDIAN_BRIDGE_TOKEN: 'tok-abcdef-123456' } });
  });

  it('module wiring: agy spawns get the real bridge connection info; toggles are honoured', async () => {
    const { ctx, store } = await load(newFake(), {}, { bridge: true });
    const bridge = ctx.services.require('bridgeServer');
    const plan = await ctx.spawn.resolve(spawnCtx('agy'));
    expect(plan.env).toEqual({ [BRIDGE_URL_ENV]: bridge.baseUrl, [BRIDGE_TOKEN_ENV]: bridge.token });
    expect(plan.args).toEqual([]);
    expect((await ctx.spawn.resolve(spawnCtx('shell'))).env).toEqual({});
    store.settings.agyBridgeEnabled = false;
    expect((await ctx.spawn.resolve(spawnCtx('agy'))).env).toEqual({});
    store.settings.agyBridgeEnabled = true;
    store.settings.bridgeEnabled = false;
    expect((await ctx.spawn.resolve(spawnCtx('agy'))).env).toEqual({});
  });
});

/** Runs the installed shim like agy would, with the env of a resolved agy spawn plan. */
function runShim(env: Record<string, string>, messages: object[], expectLines: number): Promise<{ lines: Record<string, unknown>[]; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [shimPath()], { env: { PATH: process.env.PATH ?? '', HOME: homedir(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`shim timed out; stdout so far: ${out}`));
    }, 10_000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.split('\n').filter(Boolean).length >= expectLines) child.stdin.end();
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ lines: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)), stderr: err, code });
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}

describe('shim ↔ real bridge (R11.6, R11.7)', () => {
  it('R11.6: the shim started with the agy spawn env forwards get_active_note to this vault\'s bridge', async () => {
    const s = await load(newFake(), {}, { bridge: true });
    const note = s.env.addNote('Notes/X.md', 'hello from X');
    s.env.focus(note.leaf);
    const plan = await s.ctx.spawn.resolve(spawnCtx('agy'));
    const token = s.ctx.services.require('bridgeServer').token;
    const { lines, stderr, code } = await runShim(
      plan.env,
      [
        { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'antigravity-client', version: 'v1.0.0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 'call-4', method: 'tools/call', params: { name: 'get_active_note', arguments: {} } },
      ],
      4,
    );
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3, 'call-4']);
    expect(lines[0]!.error).toBeDefined(); // agy falls back to initialize (seen with its own servers)
    expect((lines[1]!.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    const tools = (lines[2]!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toContain('get_active_note');
    const text = (lines[3]!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ path: 'Notes/X.md', content: 'hello from X' });
    expect(JSON.stringify(lines)).not.toContain(token);
  });

  it('R11.7: without the variables (agy outside Obsidian) the shim lists no tools and shows no error', async () => {
    await load(newFake());
    const { lines, stderr, code } = await runShim(
      {},
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ],
      2,
    );
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(lines[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
  });
});
