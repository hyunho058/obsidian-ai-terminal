import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGY_LOCK_FILE,
  AgyConfig,
  FileLock,
  isShimEntry,
  parseMcpList,
  shimCommandLine,
  type AgyConfigOptions,
} from '../../src/bridge/agyConfig';
import { supportDir } from '../../src/support/installScripts';
import { DUMMY_SECRET, createFakeAgy, secretConfig, type FakeAgy } from './fakeAgy';

const PY = '/opt/homebrew/bin/python3';
const SHIM = join(homedir(), '.config', 'obsidian-ai-terminal', 'mcp_shim.py');

// One temp HOME per file (tests/setup.ts): start every test with no agy config and no lock.
beforeEach(() => {
  rmSync(join(homedir(), '.gemini'), { recursive: true, force: true });
  rmSync(join(supportDir(), AGY_LOCK_FILE), { force: true });
});

function envWith(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  return { ...env, ...extra };
}

function setup(opts: Partial<AgyConfigOptions> = {}): { fake: FakeAgy; config: AgyConfig; lockPath: string } {
  const fake = createFakeAgy(mkdtempSync(join(tmpdir(), 'fake-agy-')));
  const lockPath = join(supportDir(), AGY_LOCK_FILE);
  const config = new AgyConfig({ getCommand: () => fake.path, getEnv: () => envWith(), ...opts });
  return { fake, config, lockPath };
}

describe('parseMcpList', () => {
  it('parses agy 1.3.0 output, including names with spaces and disabled / http rows', () => {
    const out = [
      'NAME      TYPE   STATUS    COMMAND/URL',
      'api       http   enabled   https://example.com/mcp',
      'envsrv    stdio  disabled  npx -y some-pkg --flag a b',
      'obsidian  stdio  enabled   /opt/homebrew/bin/python3 /Users/me/.config/obsidian-ai-terminal/mcp_shim.py',
      'sp ace    stdio  enabled   /bin/echo hi',
      '',
    ].join('\n');
    expect(parseMcpList(out)).toEqual([
      { name: 'api', type: 'http', status: 'enabled', command: 'https://example.com/mcp' },
      { name: 'envsrv', type: 'stdio', status: 'disabled', command: 'npx -y some-pkg --flag a b' },
      { name: 'obsidian', type: 'stdio', status: 'enabled', command: '/opt/homebrew/bin/python3 /Users/me/.config/obsidian-ai-terminal/mcp_shim.py' },
      { name: 'sp ace', type: 'stdio', status: 'enabled', command: '/bin/echo hi' },
    ]);
  });

  it('handles the empty list, colours, wide characters, and rejects unknown output', () => {
    expect(parseMcpList('No MCP servers configured.\n')).toEqual([]);
    expect(parseMcpList('\u001b[1mNAME\u001b[0m      TYPE   STATUS   COMMAND/URL\nobsidian  stdio  enabled  /p /s/mcp_shim.py\n')).toEqual([
      { name: 'obsidian', type: 'stdio', status: 'enabled', command: '/p /s/mcp_shim.py' },
    ]);
    expect(parseMcpList('NAME    TYPE   STATUS   COMMAND/URL\n노트🙂  stdio  enabled  /bin/x\n')).toEqual([
      { name: '노트🙂', type: 'stdio', status: 'enabled', command: '/bin/x' },
    ]);
    expect(parseMcpList('{"servers": []}')).toBeNull();
    expect(parseMcpList('')).toBeNull();
  });

  it('recognises entries made by this plugin (old `<python> <shim>` and current `<python> -I <shim>` forms)', () => {
    expect(isShimEntry({ name: 'obsidian', type: 'stdio', status: 'enabled', command: '/usr/bin/python3 /old/home/.config/obsidian-ai-terminal/mcp_shim.py' })).toBe(true);
    expect(isShimEntry({ name: 'obsidian', type: 'stdio', status: 'enabled', command: '/usr/bin/python3 -I /old/home/.config/obsidian-ai-terminal/mcp_shim.py' })).toBe(true);
    expect(shimCommandLine(PY, SHIM)).toBe(`${PY} -I ${SHIM}`);
    expect(isShimEntry({ name: 'obsidian', type: 'http', status: 'enabled', command: 'http://127.0.0.1:1234/mcp' })).toBe(false);
    expect(isShimEntry({ name: 'obsidian', type: 'stdio', status: 'enabled', command: 'npx obsidian-mcp-server' })).toBe(false);
  });
});

describe('AgyConfig.ensureEntry (fake agy, temp HOME)', () => {
  it('R11.3: adds `obsidian` → <python> -I <shim> with `--` when missing; other entries unchanged', async () => {
    const { fake, config, lockPath } = setup();
    const original = fake.writeConfig(secretConfig());
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'added' });
    expect(fake.mcpCalls()).toEqual([
      ['mcp', 'list'],
      ['mcp', 'add', 'obsidian', '--', PY, '-I', SHIM],
    ]);
    const cfg = fake.readConfig()!;
    expect(cfg.mcpServers.obsidian).toEqual({ args: ['-I', SHIM], command: PY, disabled: false });
    expect(cfg.mcpServers.context7).toEqual(secretConfig().mcpServers.context7);
    expect(cfg.mcpServers.remote).toEqual(secretConfig().mcpServers.remote);
    // every other entry's bytes are still in the file
    for (const name of ['context7', 'remote']) {
      const block = JSON.stringify({ [name]: secretConfig().mcpServers[name] }, null, 2).split('\n').slice(1, -1).join('\n');
      expect(fake.readConfigRaw()).toContain(block.replace(/^ {2}/gm, '    '));
    }
    expect(fake.calls().some((c) => c.concurrent)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(original).toContain(DUMMY_SECRET);
  });

  it('R11.4: does not run add when the entry already has the same command (idempotent)', async () => {
    const { fake, config } = setup();
    fake.writeConfig(secretConfig());
    await config.ensureEntry(PY, SHIM);
    const after = fake.readConfigRaw();
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'unchanged' });
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'unchanged' });
    expect(fake.mcpCalls('add')).toHaveLength(1);
    expect(fake.mcpCalls('list')).toHaveLength(3);
    expect(fake.readConfigRaw()).toBe(after);
  });

  it('updates an entry whose command differs and keeps a disabled entry disabled', async () => {
    const { fake, config } = setup();
    fake.writeConfig({ mcpServers: { obsidian: { args: ['/old/mcp_shim.py'], command: '/usr/bin/python3', disabled: true } } });
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'updated' });
    expect(fake.mcpCalls().map((a) => a[1])).toEqual(['list', 'add', 'disable']);
    expect(fake.readConfig()!.mcpServers.obsidian).toEqual({ args: ['-I', SHIM], command: PY, disabled: true });
  });

  it('deviation 19: an entry in the old `<python> <shim>` form is updated once to `<python> -I <shim>`, then left alone', async () => {
    const { fake, config } = setup();
    fake.writeConfig({ mcpServers: { ...secretConfig().mcpServers, obsidian: { args: [SHIM], command: PY, disabled: false } } });
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'updated' });
    expect(fake.mcpCalls('add')).toEqual([['mcp', 'add', 'obsidian', '--', PY, '-I', SHIM]]);
    const cfg = fake.readConfig()!;
    expect(cfg.mcpServers.obsidian).toEqual({ args: ['-I', SHIM], command: PY, disabled: false });
    expect(cfg.mcpServers.context7).toEqual(secretConfig().mcpServers.context7);
    const after = fake.readConfigRaw();
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'unchanged' });
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'unchanged' });
    expect(fake.mcpCalls('add')).toHaveLength(1);
    expect(fake.readConfigRaw()).toBe(after);
    // The updated entry is still recognised as ours: turning the bridge off removes it.
    expect(await config.removeEntry()).toEqual({ status: 'removed' });
  });

  it('leaves an `obsidian` entry it did not create alone', async () => {
    const { fake, config } = setup();
    const raw = fake.writeConfig({ mcpServers: { obsidian: { serverUrl: 'http://127.0.0.1:27123/mcp', headers: { 'X-Key': DUMMY_SECRET } } } });
    // The outcome never carries the foreign entry's command / URL (it may hold a secret).
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'foreign' });
    expect(await config.removeEntry()).toEqual({ status: 'foreign' });
    expect(fake.mcpCalls().map((a) => a[1])).toEqual(['list', 'list']);
    expect(fake.readConfigRaw()).toBe(raw);
  });

  it('never adds when `agy mcp list` fails, the config is malformed or the output is unrecognised', async () => {
    const { fake, config } = setup();
    fake.control({ fail: ['list'] });
    const failed = await config.ensureEntry(PY, SHIM);
    expect(failed.status).toBe('failed');
    expect((failed as { reason: string }).reason).toContain('simulated failure of list');

    fake.control({});
    const broken = fake.writeConfig(`{"mcpServers": {"x": {"env": {"K": "${DUMMY_SECRET}"}}, BROKEN`);
    expect((await config.ensureEntry(PY, SHIM)).status).toBe('failed');
    expect(fake.readConfigRaw()).toBe(broken);

    fake.writeConfig(secretConfig());
    fake.control({ listOutput: '[{"name":"x"}]\n' });
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'failed', reason: 'unrecognised `agy mcp list` output' });
    expect(fake.mcpCalls('add')).toEqual([]);
  });

  it('skips without failing when agy is not installed', async () => {
    const missing = new AgyConfig({ getCommand: () => 'agy', getEnv: () => envWith({ PATH: mkdtempSync(join(tmpdir(), 'nopath-')) }) });
    expect(await missing.ensureEntry(PY, SHIM)).toEqual({ status: 'skipped', reason: 'agy not found' });
    expect(await missing.removeEntry()).toEqual({ status: 'skipped', reason: 'agy not found' });
    const badPath = new AgyConfig({ getCommand: () => '/nonexistent/agy', getEnv: () => envWith() });
    expect((await badPath.ensureEntry(PY, SHIM)).status).toBe('skipped');
  });

  it('resolves the profile command on the given PATH (and ~/ paths)', () => {
    const fake = createFakeAgy(mkdtempSync(join(tmpdir(), 'fake-agy-')));
    expect(new AgyConfig({ getCommand: () => 'agy', getEnv: () => envWith({ PATH: `/nonexistent:${fake.dir}` }) }).resolveAgy()).toBe(fake.path);
    const homeBin = join(homedir(), 'bin');
    mkdirSync(homeBin, { recursive: true });
    const inHome = createFakeAgy(homeBin);
    expect(new AgyConfig({ getCommand: () => '~/bin/agy', getEnv: () => envWith() }).resolveAgy()).toBe(inHome.path);
  });

  it('kills a hanging `agy mcp list` after its timeout', async () => {
    const { fake, config } = setup({ listTimeoutMs: 300 });
    fake.control({ hang: ['list'] });
    const started = Date.now();
    const outcome = await config.ensureEntry(PY, SHIM);
    expect(outcome).toEqual({ status: 'failed', reason: 'agy mcp list: timed out' });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('AgyConfig.removeEntry', () => {
  it('R11.8: removes the entry; the config is byte-identical to before the add', async () => {
    const { fake, config } = setup();
    const original = fake.writeConfig(secretConfig());
    await config.ensureEntry(PY, SHIM);
    expect(fake.readConfigRaw()).not.toBe(original);
    expect(await config.removeEntry()).toEqual({ status: 'removed' });
    expect(fake.mcpCalls().slice(-2)).toEqual([
      ['mcp', 'list'],
      ['mcp', 'remove', 'obsidian'],
    ]);
    expect(fake.readConfigRaw()).toBe(original);
    expect(await config.removeEntry()).toEqual({ status: 'absent' });
    expect(fake.mcpCalls('remove')).toHaveLength(1);
  });

  it('reports a failed remove', async () => {
    const { fake, config } = setup();
    fake.writeConfig({ mcpServers: { obsidian: { args: [SHIM], command: PY } } });
    fake.control({ fail: ['remove'] });
    const outcome = await config.removeEntry();
    expect(outcome.status).toBe('failed');
  });
});

describe('lock file', () => {
  it('R11.5: two plugin instances ensuring at once run one add, never concurrently', async () => {
    const fake = createFakeAgy(mkdtempSync(join(tmpdir(), 'fake-agy-')));
    const original = secretConfig();
    fake.writeConfig(original);
    fake.control({ delayMs: 250 });
    const make = () => new AgyConfig({ getCommand: () => fake.path, getEnv: () => envWith() });
    const [a, b] = [make(), make()];
    const outcomes = await Promise.all([a.ensureEntry(PY, SHIM), b.ensureEntry(PY, SHIM)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['added', 'unchanged']);
    expect(fake.mcpCalls('add')).toHaveLength(1);
    expect(fake.calls().some((c) => c.concurrent)).toBe(false);
    const cfg = fake.readConfig()!;
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['context7', 'obsidian', 'remote']);
    expect(cfg.mcpServers.context7).toEqual(original.mcpServers.context7);
  });

  it('serialises operations of one instance (ensure then remove)', async () => {
    const { fake, config } = setup();
    fake.control({ delayMs: 100 });
    const [ensured, removed] = await Promise.all([config.ensureEntry(PY, SHIM), config.removeEntry()]);
    expect([ensured.status, removed.status]).toEqual(['added', 'removed']);
    expect(fake.mcpCalls().map((a) => a[1])).toEqual(['list', 'add', 'list', 'remove']);
    expect(fake.calls().some((c) => c.concurrent)).toBe(false);
  });

  it('recovers a lock left by a dead process', async () => {
    const { fake, config, lockPath } = setup();
    mkdirSync(supportDir(), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, nonce: 'dead', createdAt: Date.now() }));
    const started = Date.now();
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'added' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(existsSync(lockPath)).toBe(false);
    expect(fake.mcpCalls('add')).toHaveLength(1);
  });

  it('recovers a lock older than the stale age even if its pid is alive', async () => {
    const { config, lockPath } = setup({ lockStaleMs: 30_000 });
    mkdirSync(supportDir(), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 1, nonce: 'launchd', createdAt: 0 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'added' });
  });

  it('waits for a live lock and gives up after lockWaitMs; succeeds once it is released', async () => {
    const { fake, config, lockPath } = setup({ lockWaitMs: 400 });
    const holder = new FileLock(lockPath);
    expect(await holder.acquire(100)).toBe(true);
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'skipped', reason: 'another Obsidian window is updating the agy entry' });
    expect(fake.calls()).toEqual([]);
    const pending = config.ensureEntry(PY, SHIM);
    setTimeout(() => holder.release(), 150);
    expect(await pending).toEqual({ status: 'added' });
  });

  it('release never deletes a lock that is not ours; dispose releases a held lock synchronously', async () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), 'lock-')), 'x.lock');
    const a = new FileLock(lockPath);
    await a.acquire(100);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: 'someone-else', createdAt: Date.now() }));
    a.release();
    expect(existsSync(lockPath)).toBe(true);

    const { fake, config, lockPath: agyLock } = setup();
    fake.control({ delayMs: 400 });
    const running = config.ensureEntry(PY, SHIM);
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(agyLock)).toBe(true);
    config.dispose();
    expect(existsSync(agyLock)).toBe(false);
    expect(await running).toEqual({ status: 'skipped', reason: 'plugin unloading' });
    expect(await config.ensureEntry(PY, SHIM)).toEqual({ status: 'skipped', reason: 'plugin unloading' });
  });
});
