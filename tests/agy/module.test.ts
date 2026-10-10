import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { ALLOW_RULE_NOTICE, createAgyModule, FOREIGN_ENTRY_NOTICE, type AgyModuleOptions } from '../../src/bridge/agyModule';
import { AGY_ALLOW_RULE, agySettingsPath } from '../../src/bridge/agyPermissions';
import { AGY_LOCK_FILE, shimCommand } from '../../src/bridge/agyConfig';
import { createAgyEnvContributor } from '../../src/bridge/agyEnvContributor';
import type { BridgeEndpoint } from '../../src/bridge/httpServer';
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, TOOLS_OFF_MESSAGE, createBridgeModule } from '../../src/bridge/index';
import type { SpawnContext } from '../../src/core/spawn';
import type { FeatureModule } from '../../src/core/types';
import { supportDir } from '../../src/support/installScripts';
import { setDebugLogging } from '../../src/util/log';
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
      ['mcp', 'add', 'obsidian', '--', PY, '-I', shimPath()],
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
    expect(Notice.shown[0]!.message).toBe(FOREIGN_ENTRY_NOTICE);
    expect(Notice.shown[0]!.message).toContain('agy mcp remove obsidian');
  });

  it('deviation 19: a foreign entry\'s command / URL / headers never reach a Notice, a log line or the service', async () => {
    const SECRET = 'sk-fake-FOREIGN-0123456789abcdef';
    const fake = newFake();
    setDebugLogging(true); // capture every log level
    onTestFinished(() => setDebugLogging(false));
    for (const foreign of [
      { serverUrl: `https://user:${SECRET}@mcp.example.com/obsidian?token=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } },
      { command: '/usr/local/bin/obsidian-mcp', args: ['--api-key', SECRET], env: { OBSIDIAN_API_KEY: SECRET } },
    ]) {
      Notice.clear();
      const raw = fake.writeConfig({ mcpServers: { obsidian: foreign } });
      const s = await load(fake);
      // Turning the agy bridge off: the remove path meets the same foreign entry.
      s.store.settings.agyBridgeEnabled = false;
      await s.ctx.saveSettings();
      await waitFor(() => s.ctx.services.require('agyBridge').lastOutcome?.status === 'foreign' && fake.mcpCalls('list').length >= 2);
      expect(fake.readConfigRaw()).toBe(raw);
      expect(Notice.shown.map((n) => n.message)).toEqual([FOREIGN_ENTRY_NOTICE]);
      const seen = [...Notice.shown.map((n) => n.message), ...s.out.lines, JSON.stringify(s.ctx.services.require('agyBridge').lastOutcome)].join('\n');
      expect(s.out.lines.some((l) => l.includes('not created by this plugin'))).toBe(true);
      expect(s.out.lines.some((l) => l.includes('agy mcp list'))).toBe(true); // debug lines were captured too
      for (const leak of [SECRET, 'mcp.example.com', '/usr/local/bin/obsidian-mcp', '--api-key']) expect(seen).not.toContain(leak);
      s.runtime.unload();
      rmSync(join(homedir(), '.gemini'), { recursive: true, force: true });
      for (const f of ['calls.log', 'control.json']) rmSync(join(fake.dir, f), { force: true });
    }
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

describe('agy allow rule (deviation 22)', () => {
  const DUMMY = 'DUMMY-SETTINGS-VALUE-sk-0123456789abcdef';
  const userSettings = (allow: string[] = ['mcp(chrome_devtools/*)']) => ({
    allowNonWorkspaceAccess: false,
    model: 'gemini-3-pro',
    permissions: { allow },
    trustedWorkspaces: ['/Users/me/vault'],
    secretish: DUMMY,
  });
  const writeSettings = (raw: string | object): string => {
    const text = typeof raw === 'string' ? raw : `${JSON.stringify(raw, null, 2)}\n`;
    mkdirSync(dirname(agySettingsPath()), { recursive: true });
    writeFileSync(agySettingsPath(), text, { mode: 0o600 });
    return text;
  };
  const readSettings = (): Record<string, any> => JSON.parse(readFileSync(agySettingsPath(), 'utf8'));
  const flag = (s: Started): unknown => (s.ctx.settings.moduleData.agy as { allowRuleAdded?: boolean } | undefined)?.allowRuleAdded;
  const rule = (s: Started) => s.ctx.services.require('agyBridge').lastAllowRuleOutcome;

  it('end to end: after ready with the fake agy, both the `obsidian` entry and the allow rule exist (no Notice)', async () => {
    const fake = newFake();
    const s = await load(fake);
    expect(fake.readConfig()!.mcpServers.obsidian).toEqual({ command: PY, args: ['-I', shimPath()], disabled: false });
    expect(readSettings()).toEqual({ permissions: { allow: [AGY_ALLOW_RULE] } });
    expect(statSync(agySettingsPath()).mode & 0o777).toBe(0o600);
    expect(rule(s)).toEqual({ status: 'added' });
    expect(flag(s)).toBe(true);
    expect(JSON.parse(JSON.stringify(s.store.settings.moduleData))).toEqual({ agy: { allowRuleAdded: true } });
    expect(Notice.shown).toEqual([]);
    expect(existsSync(join(supportDir(), AGY_LOCK_FILE))).toBe(false);
  });

  it('existing settings: the rule is appended, everything else kept; a second load changes nothing', async () => {
    const fake = newFake();
    writeSettings(userSettings());
    const s1 = await load(fake);
    expect(readSettings()).toEqual(userSettings(['mcp(chrome_devtools/*)', AGY_ALLOW_RULE]));
    const raw = readFileSync(agySettingsPath(), 'utf8');
    const s2 = await load(fake, { moduleData: s1.ctx.settings.moduleData });
    expect(rule(s2)).toEqual({ status: 'present' });
    expect(readFileSync(agySettingsPath(), 'utf8')).toBe(raw);
    expect(flag(s2)).toBe(true); // still ours from the first load
  });

  it('a rule the user already had: file byte-identical, flag NOT set; turning the bridge off keeps it', async () => {
    const fake = newFake();
    const raw = writeSettings(userSettings([AGY_ALLOW_RULE, 'mcp(chrome_devtools/*)']));
    const s = await load(fake);
    expect(rule(s)).toEqual({ status: 'present' });
    expect(readFileSync(agySettingsPath(), 'utf8')).toBe(raw);
    expect(flag(s)).toBeUndefined();
    s.store.settings.agyBridgeEnabled = false;
    await s.ctx.saveSettings();
    await waitFor(() => s.ctx.services.require('agyBridge').lastOutcome?.status === 'removed');
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.readConfig()!.mcpServers.obsidian).toBeUndefined();
    expect(readFileSync(agySettingsPath(), 'utf8')).toBe(raw);
  });

  it('turning the bridge off removes the rule the plugin added (others kept, file kept) and clears the flag; on adds it again', async () => {
    const fake = newFake();
    writeSettings(userSettings());
    const s = await load(fake);
    expect(flag(s)).toBe(true);
    s.store.settings.agyBridgeEnabled = false;
    await s.ctx.saveSettings();
    await waitFor(() => rule(s)?.status === 'removed');
    expect(readSettings()).toEqual(userSettings());
    expect(statSync(agySettingsPath()).mode & 0o777).toBe(0o600);
    await waitFor(() => flag(s) === undefined);
    expect(fake.readConfig()!.mcpServers.obsidian).toBeUndefined();
    s.store.settings.agyBridgeEnabled = true;
    await s.ctx.saveSettings();
    await waitFor(() => rule(s)?.status === 'added');
    expect(readSettings()).toEqual(userSettings(['mcp(chrome_devtools/*)', AGY_ALLOW_RULE]));
    await waitFor(() => flag(s) === true);
    expect(Notice.shown).toEqual([]);
  });

  it('turning the bridge off with a user-added rule next to ours removes only ours', async () => {
    const fake = newFake();
    writeSettings(userSettings());
    const s = await load(fake);
    // The user adds a rule of their own afterwards.
    const now = readSettings();
    now.permissions.allow.push('mcp(obsidian/get_selection)');
    writeSettings(now);
    s.store.settings.agyBridgeEnabled = false;
    await s.ctx.saveSettings();
    await waitFor(() => rule(s)?.status === 'removed');
    expect(readSettings()).toEqual(userSettings(['mcp(chrome_devtools/*)', 'mcp(obsidian/get_selection)']));
  });

  it('unparsable settings: byte-identical, skipped, one Notice; the file contents never reach a log line', async () => {
    setDebugLogging(true);
    onTestFinished(() => setDebugLogging(false));
    const fake = newFake();
    const raw = writeSettings(`{ "model": "x", "token": "${DUMMY}", `);
    const s = await load(fake, {}, { recheckDelayMs: 20 });
    expect(rule(s)).toMatchObject({ status: 'skipped', settingsProblem: true });
    expect(readFileSync(agySettingsPath(), 'utf8')).toBe(raw);
    expect(Notice.shown.map((n) => n.message)).toEqual([ALLOW_RULE_NOTICE]);
    expect(flag(s)).toBeUndefined();
    // A later re-check does not repeat the Notice.
    s.store.settings.pythonPath = '/usr/bin/python3';
    await s.ctx.saveSettings();
    await waitFor(() => fake.mcpCalls('list').length === 2);
    await waitFor(() => s.out.lines.filter((l) => l.includes('agy allow rule ensure skipped')).length === 2);
    expect(Notice.shown).toHaveLength(1);
    expect(s.out.lines.join('\n')).not.toContain(DUMMY);
    expect(readFileSync(agySettingsPath(), 'utf8')).toBe(raw);
  });

  it('`permissions.allow` not a list: untouched, one Notice', async () => {
    const raw = writeSettings({ permissions: { allow: 'mcp(obsidian/*)' }, model: 'x' });
    const s = await load(newFake());
    expect(rule(s)).toMatchObject({ status: 'skipped', settingsProblem: true });
    expect(readFileSync(agySettingsPath(), 'utf8')).toBe(raw);
    expect(Notice.shown.map((n) => n.message)).toEqual([ALLOW_RULE_NOTICE]);
  });

  it('a foreign `obsidian` entry: no rule is written (the settings file is not even created)', async () => {
    const fake = newFake();
    fake.writeConfig({ mcpServers: { obsidian: { serverUrl: 'http://127.0.0.1:27123/mcp' } } });
    const s = await load(fake);
    expect(s.ctx.services.require('agyBridge').lastOutcome).toEqual({ status: 'foreign' });
    expect(rule(s)).toBeUndefined();
    expect(existsSync(agySettingsPath())).toBe(false);
    expect(Notice.shown.map((n) => n.message)).toEqual([FOREIGN_ENTRY_NOTICE]);
  });

  it('no rule when the entry step fails or is skipped, or when the agy bridge is off', async () => {
    const fake = newFake();
    fake.control({ fail: ['add'] });
    const s1 = await load(fake);
    expect(s1.ctx.services.require('agyBridge').lastOutcome?.status).toBe('failed');
    const s2 = await load(null);
    expect(s2.ctx.services.require('agyBridge').lastOutcome?.status).toBe('skipped');
    fake.control({});
    const s3 = await load(fake, { agyBridgeEnabled: false });
    for (const s of [s1, s2, s3]) expect(rule(s)).toBeUndefined();
    expect(existsSync(agySettingsPath())).toBe(false);
  });

  it('two plugin instances ensuring at once: the rule is there exactly once, and only one instance owns it', async () => {
    const fake = newFake();
    writeSettings(userSettings());
    fake.control({ delayMs: 100 });
    const [a, b] = await Promise.all([load(fake), load(fake)]);
    expect(readSettings().permissions.allow).toEqual(['mcp(chrome_devtools/*)', AGY_ALLOW_RULE]);
    expect([rule(a)?.status, rule(b)?.status].sort()).toEqual(['added', 'present']);
    expect([flag(a), flag(b)].filter((f) => f === true)).toHaveLength(1);
    expect(fake.calls().some((c) => c.concurrent)).toBe(false);
  });

  it('the ready step stays bounded when the settings write hangs; unload releases the lock', async () => {
    const fake = newFake();
    const t0 = Date.now();
    const s = await load(fake, {}, { readyTimeoutMs: 400, permissions: { writeNewFile: () => new Promise(() => {}) } });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(s.ctx.isReady()).toBe(true);
    await waitFor(() => s.ctx.services.require('agyBridge').lastOutcome?.status === 'added');
    await new Promise((r) => setTimeout(r, 300)); // the rule step is now stuck in its write
    expect(fake.readConfig()!.mcpServers.obsidian).toBeDefined();
    expect(existsSync(agySettingsPath())).toBe(false);
    expect(rule(s)).toBeUndefined();
    expect(s.out.lines.some((l) => l.includes('still running after 400 ms'))).toBe(true);
    expect(existsSync(join(supportDir(), AGY_LOCK_FILE))).toBe(true);
    s.runtime.unload();
    expect(existsSync(join(supportDir(), AGY_LOCK_FILE))).toBe(false);
  });

  it('the ready step completes when the settings write fails (logged, no Notice, file untouched)', async () => {
    const fake = newFake();
    const raw = writeSettings(userSettings());
    chmodSync(dirname(agySettingsPath()), 0o500);
    onTestFinished(() => chmodSync(dirname(agySettingsPath()), 0o700));
    const s = await load(fake);
    expect(s.ctx.isReady()).toBe(true);
    expect(rule(s)).toMatchObject({ status: 'failed' });
    expect(readFileSync(agySettingsPath(), 'utf8')).toBe(raw);
    expect(flag(s)).toBeUndefined();
    expect(Notice.shown).toEqual([]);
    expect(s.out.lines.some((l) => l.includes('agy allow rule ensure failed'))).toBe(true);
  });
});

describe('agy env contributor', () => {
  const server = (over: Partial<BridgeEndpoint> = {}): BridgeEndpoint => ({
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

  it('deviation 19: bridge tools off while the server runs for snapshots → agy panels get no bridge env', async () => {
    const snapshotsLike: FeatureModule = {
      id: 'snapshots-like',
      register(ctx) {
        ctx.onUnload(ctx.services.require('bridgeServer').keepRunningWhile('snapshots', () => true));
      },
    };
    const settings = { profiles: { agy: { command: newFake().path, args: '' } }, bridgeEnabled: false };
    const s = await startAgyRuntime([stubPythonModule(PY), createBridgeModule(), createAgyModule(), snapshotsLike], settings);
    started.push(s);
    expect(s.ctx.services.require('bridgeServer').isRunning()).toBe(true);
    expect(s.ctx.settings.agyBridgeEnabled).toBe(true);
    const plan = await s.ctx.spawn.resolve(spawnCtx('agy'));
    expect(plan.env).toEqual({});
    expect(plan.args).toEqual([]);
  });
});

/** Runs the installed shim like agy would (the registered `<python> -I <shim>` command), with the env of a resolved agy spawn plan. */
function runShim(env: Record<string, string>, messages: object[], expectLines: number): Promise<{ lines: Record<string, unknown>[]; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const [python, ...args] = shimCommand(PY, shimPath());
    const child = spawn(python!, args, { env: { PATH: process.env.PATH ?? '', HOME: homedir(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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

  it('deviation 20: an agy started before the tools were turned off gets the plain "turned off" message, and works again once they are back on', async () => {
    const s = await load(newFake(), {}, { bridge: true });
    const server = s.ctx.services.require('bridgeServer');
    const plan = await s.ctx.spawn.resolve(spawnCtx('agy'));
    const list = (id: number) => [{ jsonrpc: '2.0', id, method: 'tools/list', params: {} }];
    s.ctx.settings.bridgeEnabled = false;
    await s.ctx.saveSettings();
    expect(server.isRunning()).toBe(true);
    const off = await runShim(plan.env, list(1), 1);
    expect(off.stderr).toBe('');
    expect(off.lines).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `Obsidian bridge error (HTTP 403): ${TOOLS_OFF_MESSAGE}` } }]);
    s.ctx.settings.bridgeEnabled = true;
    await s.ctx.saveSettings();
    expect(plan.env[BRIDGE_URL_ENV]).toBe(server.baseUrl);
    const on = await runShim(plan.env, list(2), 1);
    expect((on.lines[0]!.result as { tools: unknown[] }).tools).toHaveLength(5);
    expect(JSON.stringify([off.lines, on.lines])).not.toContain(server.token);
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
