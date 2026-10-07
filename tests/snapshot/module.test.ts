import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridgeModule } from '../../src/bridge/index';
import type { BeforeSpawnContext } from '../../src/core/events';
import type { ProfileId } from '../../src/core/constants';
import type { SpawnContext } from '../../src/core/spawn';
import {
  claudeHookSettings,
  createSnapshotModule,
  FIRST_USE_QUESTION,
  PANEL_ID_ENV,
  type FirstUseAnswer,
  type SnapshotModuleOptions,
} from '../../src/snapshot/index';
import { hasSettingsArg, shellQuote, USER_SETTINGS_NOTICE } from '../../src/snapshot/claudeHookContributor';
import { NOTES } from '../../src/snapshot/messages';
import { Notice, TFile, TFolder } from '../mocks/obsidian';
import { commitCount, fakePanel, gitWrapper, makeVault, sleep, startRuntime, tempDir, writeFile, type FakePanel } from './helpers';

const TOKEN = 'snapshot-test-token-0123456789';
const HOOK_SOURCE = resolve(__dirname, '../../src/snapshot/snapshot_hook.py');

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const runtimes: Runtime[] = [];

interface LoadOptions extends SnapshotModuleOptions {
  vault?: string;
  enabled?: boolean | null;
  bridge?: boolean;
  bridgeEnabled?: boolean;
  panels?: FakePanel[];
  answers?: FirstUseAnswer[];
  /** Copy the hook into the plugin folder (as the build does). */
  withHook?: boolean;
  /** Use the real first-use modal instead of the scripted answers. */
  realModal?: boolean;
}

/** Loads the plugin runtime with the snapshot module (+ T6 bridge) over a temp vault. */
async function load(o: LoadOptions = {}) {
  const vault = o.vault ?? makeVault({ 'note.md': 'hello' });
  const asked: Array<(a: FirstUseAnswer) => void> = [];
  const answers = [...(o.answers ?? [])];
  const openFirstUse: SnapshotModuleOptions['openFirstUse'] = o.realModal
    ? undefined
    : (() => (answer) => {
      const next = answers.shift();
      if (next) queueMicrotask(() => answer(next));
      else asked.push(answer);
      return { close: () => answer('dismiss') };
    });
  let pluginDir: string | undefined;
  if (o.withHook) {
    pluginDir = tempDir('plugindir-');
    copyFileSync(HOOK_SOURCE, join(pluginDir, 'snapshot_hook.py'));
  }
  const modules = [
    ...(o.bridge === false ? [] : [createBridgeModule({ token: TOKEN })]),
    createSnapshotModule({ checkGit: async () => ({ ok: true, version: 'git version test' }), ...o, openFirstUse }),
  ];
  const rt = await startRuntime({
    vault,
    modules,
    panels: o.panels,
    pluginDir,
    data: { snapshots: { enabled: o.enabled === undefined ? true : o.enabled }, bridgeEnabled: o.bridgeEnabled ?? true },
  });
  runtimes.push(rt);
  const service = rt.ctx.services.require('snapshots');
  return { ...rt, vault, service, asked };
}

function spawnHookCtx(profile: ProfileId, printed: string[], panelId = `${profile}-1`): BeforeSpawnContext {
  return { panelId, profile, phase: 'new', vaultPath: '/vault', print: (l) => void printed.push(l) };
}

function spawnCtx(profile: ProfileId, baseArgs: string[] = []): SpawnContext {
  return { profile, panelId: 'panel-7', vaultPath: '/vault', phase: 'new', command: profile, baseArgs };
}

function post(url: string, body: string, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolvePost, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolvePost({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function snapshotUrl(rt: Runtime): string {
  return `${rt.ctx.services.require('bridgeServer').baseUrl}/snapshot`;
}

beforeEach(() => Notice.clear());
afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    if (!rt.ctx.unloading) rt.runtime.unload();
  }
});

describe('snapshot module wiring', () => {
  it('R12.6 / D31: the change flag is set on load and by note / folder events only', async () => {
    const { service, app } = await load();
    expect(service.hasChanges()).toBe(true);
    const clear = () => (service as unknown as { flag: { clear(): void } }).flag.clear();
    const cases: Array<[string, () => void, boolean]> = [
      ['modify note', () => app.vault.trigger('modify', new TFile('a.md')), true],
      ['create canvas', () => app.vault.trigger('create', new TFile('b.canvas')), true],
      ['delete base', () => app.vault.trigger('delete', new TFile('c.base')), true],
      ['modify image', () => app.vault.trigger('modify', new TFile('img.png')), false],
      ['rename png → md', () => app.vault.trigger('rename', new TFile('x.md'), 'x.png'), true],
      ['rename md → txt', () => app.vault.trigger('rename', new TFile('x.txt'), 'x.md'), true],
      ['rename folder', () => app.vault.trigger('rename', new TFolder('dir2'), 'dir'), true],
      ['delete folder', () => app.vault.trigger('delete', new TFolder('dir')), true],
    ];
    for (const [name, fire, expected] of cases) {
      clear();
      fire();
      expect([name, service.hasChanges()]).toEqual([name, expected]);
    }
  });

  it('R12.6: an edit made while Obsidian was closed is in the snapshot before the first prompt', async () => {
    const vault = makeVault({ 'note.md': 'v1' });
    const first = await load({ vault });
    expect((await first.service.snapshotNow({ kind: 'first' })).status).toBe('committed');
    first.runtime.unload();
    writeFile(vault, 'note.md', 'edited by another app'); // no vault event: Obsidian is closed
    const second = await load({ vault });
    expect(second.service.hasChanges()).toBe(true);
    const r = await post(snapshotUrl(second), JSON.stringify({ panelId: 'p', prompt: 'first prompt', ai: 'claude' }), TOKEN);
    expect(r.json.status).toBe('committed');
    expect((await second.service.readFileAt(r.json.commit as string, 'note.md')).toString()).toBe('edited by another app');
  });

  it('R11.9: the hook script is registered and installed to ~/.config/obsidian-ai-terminal/snapshot_hook.py', async () => {
    const rt = await load({ withHook: true });
    await rt.ctx.supportScripts.whenInstalled();
    expect(rt.ctx.supportScripts.registered()).toContain('snapshot_hook.py');
    const installed = join(homedir(), '.config', 'obsidian-ai-terminal', 'snapshot_hook.py');
    expect(readFileSync(installed, 'utf8')).toBe(readFileSync(HOOK_SOURCE, 'utf8'));
  });

  it('unload: the service stops taking snapshots and the route is gone', async () => {
    const rt = await load();
    rt.runtime.unload();
    expect(await rt.service.requestSnapshot({ kind: 'prompt', ai: 'claude' }, { waitMs: 100 })).toEqual({ status: 'disabled' });
    expect(rt.ctx.routes.list()).toEqual([]);
  });
});

describe('spawn-time snapshot and first use (R12.1, R12.8, R12.15)', () => {
  it('R12.8: an AI spawn with changes commits before the program starts', async () => {
    const { ctx, service } = await load();
    const printed: string[] = [];
    await ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', printed));
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'spawn', ai: 'claude', panelId: 'claude-1' });
    expect(list[0]!.subject).toMatch(/^Before Claude Code session — \d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(printed).toEqual([]);
    // Restart of an agy panel without changes: nothing new.
    await ctx.sessionEvents.runBeforeSpawn({ ...spawnHookCtx('agy', printed), phase: 'restart' });
    expect(await service.list()).toHaveLength(1);
  });

  it('R12.15: shell panels never snapshot or ask', async () => {
    const { ctx, service, asked } = await load({ enabled: null });
    const printed: string[] = [];
    await ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('shell', printed));
    expect(asked).toHaveLength(0);
    const on = await load();
    await on.ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('shell', printed));
    expect(existsSync(on.service.storePath)).toBe(false);
    expect(service.hasChanges()).toBe(true);
  });

  it('R12.1: the spawn waits for the answer; Enable stores true and runs the first full snapshot in the background', async () => {
    const { ctx, service, plugin, asked } = await load({ enabled: null });
    const printed: string[] = [];
    let done = false;
    const spawn = ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', printed)).then(() => (done = true));
    await sleep(50);
    expect(done).toBe(false);
    expect(asked).toHaveLength(1);
    asked[0]!('enable');
    await spawn;
    expect(ctx.settings.snapshots.enabled).toBe(true);
    expect((plugin.data as { snapshots: { enabled: unknown } }).snapshots.enabled).toBe(true);
    expect(printed).toEqual([NOTES.enabled]);
    await service.whenIdle();
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'first' });
    expect(list[0]!.subject).toMatch(/^Snapshots turned on — /);
  });

  it('R12.1: Don\'t enable stores false; dismiss keeps null, takes no snapshot and asks again next launch', async () => {
    const declined = await load({ enabled: null, answers: ['decline'] });
    await declined.ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('agy', []));
    expect(declined.ctx.settings.snapshots.enabled).toBe(false);
    expect(existsSync(declined.service.storePath)).toBe(false);

    const dismissed = await load({ enabled: null, answers: ['dismiss', 'dismiss'] });
    await dismissed.ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', []));
    expect(dismissed.ctx.settings.snapshots.enabled).toBeNull();
    expect(dismissed.plugin.data).toBeNull(); // nothing saved
    await dismissed.ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', []));
    expect(existsSync(dismissed.service.storePath)).toBe(false);
  });

  it('R12.1: two AI panels restored at startup share one question', async () => {
    const { ctx, asked } = await load({ enabled: null });
    const a = ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', [], 'p1'));
    const b = ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('agy', [], 'p2'));
    await sleep(30);
    expect(asked).toHaveLength(1);
    asked[0]!('decline');
    await Promise.all([a, b]);
    expect(ctx.settings.snapshots.enabled).toBe(false);
  });

  it('the question times out as a dismiss so a spawn never waits forever', async () => {
    const { ctx, asked } = await load({ enabled: null, firstUseTimeoutMs: 80 });
    await ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', []));
    expect(asked).toHaveLength(1);
    expect(ctx.settings.snapshots.enabled).toBeNull();
  });

  it('the real modal is used by default', async () => {
    const { ctx } = await load({ enabled: null, realModal: true });
    const { Modal } = await import('../mocks/obsidian');
    const spawn = ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', []));
    await sleep(20);
    expect(Modal.open).toHaveLength(1);
    expect(Modal.open[0]!.titleEl.textContent).toBe(FIRST_USE_QUESTION);
    Modal.open[0]!.close();
    await spawn;
    expect(ctx.settings.snapshots.enabled).toBeNull();
  });

  it('R12.9 at spawn: a slow snapshot lets the program start after the wait, with a note', async () => {
    const { ctx, service } = await load({ gitPath: gitWrapper({ sleepOn: { commands: ['commit'], seconds: 1 } }), spawnWaitMs: 200 });
    const printed: string[] = [];
    const started = Date.now();
    await ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('agy', printed));
    expect(Date.now() - started).toBeLessThan(900);
    expect(printed).toEqual([NOTES.spawnPending]);
    await service.whenIdle();
    expect(await service.list()).toHaveLength(1);
  });

  it('R12.10 at spawn: a failing snapshot is reported and the spawn goes on', async () => {
    const { ctx } = await load({ gitPath: gitWrapper({ failOn: { commands: ['update-index'], message: 'disk is full' } }) });
    const printed: string[] = [];
    await ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', printed));
    expect(printed).toEqual([NOTES.spawnFailed('disk is full')]);
  });

  it('R12.16: without git, snapshots are off with one Notice and no question', async () => {
    const off = await load({ enabled: true, checkGit: async () => ({ ok: false, reason: 'the Command Line Tools are not installed' }) });
    expect(Notice.shown.map((n) => n.message)).toEqual([
      'AI Terminal: AI session snapshots are off — git is not available: the Command Line Tools are not installed.',
    ]);
    expect(off.service.isEnabled()).toBe(false);
    await off.ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', []));
    expect(Notice.shown).toHaveLength(1);

    Notice.clear();
    const undecided = await load({ enabled: null, checkGit: async () => ({ ok: false, reason: 'x' }) });
    expect(Notice.shown).toHaveLength(0);
    await undecided.ctx.sessionEvents.runBeforeSpawn(spawnHookCtx('claude', []));
    expect(undecided.asked).toHaveLength(0);
    expect(Notice.shown).toHaveLength(1);
  });

  it('turning snapshots on in settings sets the flag and starts the first snapshot in the background', async () => {
    const { ctx, service } = await load({ enabled: false });
    (service as unknown as { flag: { clear(): void } }).flag.clear();
    ctx.settings.snapshots.enabled = true;
    await ctx.saveSettings();
    await sleep(20);
    await service.whenIdle();
    const list = await service.list();
    expect(list.map((s) => s.kind)).toEqual(['first']);
    // Turning it off and on again: git decides (nothing changed → no new commit).
    ctx.settings.snapshots.enabled = false;
    await ctx.saveSettings();
    ctx.settings.snapshots.enabled = true;
    await ctx.saveSettings();
    await sleep(20);
    await service.whenIdle();
    expect(await service.list()).toHaveLength(1);
  });
});

describe('POST /snapshot (R12.3, R12.4, R12.9, R12.10)', () => {
  it('needs the bridge token (401 from T6\'s server) and commits before answering', async () => {
    const panel = fakePanel('claude', 'panel-1');
    const rt = await load({ panels: [panel] });
    const url = snapshotUrl(rt);
    const body = JSON.stringify({ panelId: 'panel-1', prompt: 'make this shorter', ai: 'claude' });
    expect((await post(url, body)).status).toBe(401);
    expect((await post(url, body, 'wrong-token-0000000000000')).status).toBe(401);
    expect(rt.service.hasChanges()).toBe(true);
    expect(existsSync(rt.service.storePath)).toBe(false);

    const ok = await post(url, body, TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: 'committed' });
    const [snap] = await rt.service.list();
    expect(snap!.commit).toBe(ok.json.commit);
    expect(snap!.subject).toMatch(/^Before Claude Code: "make this shorter" — \d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(snap).toMatchObject({ ai: 'claude', kind: 'prompt', panelId: 'panel-1', promptExcerpt: 'make this shorter' });
    expect(panel.printed).toEqual([]);

    // R12.5: no change since → no new commit.
    expect((await post(url, body, TOKEN)).json).toEqual({ status: 'unchanged', commit: ok.json.commit });
    expect(commitCount(rt.service.storePath, rt.vault)).toBe(1);
  });

  it('bad requests, shell panels and disabled snapshots', async () => {
    const shell = fakePanel('shell', 'sh-1');
    const rt = await load({ panels: [shell] });
    const url = snapshotUrl(rt);
    expect((await post(url, '{nope', TOKEN)).status).toBe(400);
    expect((await post(url, '[1]', TOKEN)).status).toBe(400);
    expect((await post(url, JSON.stringify({ panelId: 'sh-1', ai: 'claude' }), TOKEN)).json).toMatchObject({ status: 'disabled' });
    expect(existsSync(rt.service.storePath)).toBe(false);
    rt.ctx.settings.snapshots.enabled = false;
    await rt.ctx.saveSettings();
    expect((await post(url, JSON.stringify({ panelId: 'x' }), TOKEN)).json).toEqual({ status: 'disabled' });
  });

  it('R12.9: a slow snapshot answers "pending" after the wait, prints the note and commits later', async () => {
    const panel = fakePanel('claude', 'panel-1');
    const rt = await load({ panels: [panel], hookWaitMs: 300, gitPath: gitWrapper({ sleepOn: { commands: ['commit'], seconds: 1 } }) });
    const started = Date.now();
    const r = await post(snapshotUrl(rt), JSON.stringify({ panelId: 'panel-1', prompt: 'slow', ai: 'claude' }), TOKEN);
    expect(Date.now() - started).toBeLessThan(900);
    expect(r.json).toEqual({ status: 'pending' });
    expect(panel.printed).toEqual([`\r\n${NOTES.pendingClaude}\r\n`]);
    await rt.service.whenIdle();
    expect((await rt.service.list())[0]!.subject).toMatch(/^Before Claude Code: "slow"/);
  });

  it('R12.10: a git error answers "failed" with the reason and prints it in the panel', async () => {
    const panel = fakePanel('claude', 'panel-1');
    const rt = await load({ panels: [panel], gitPath: gitWrapper({ failOn: { commands: ['update-index'], message: 'disk is full' } }) });
    const r = await post(snapshotUrl(rt), JSON.stringify({ panelId: 'panel-1', prompt: 'x', ai: 'claude' }), TOKEN);
    expect(r.json).toEqual({ status: 'failed', reason: 'disk is full' });
    expect(panel.printed).toEqual(['\r\n[Snapshot failed: disk is full — this message is not protected]\r\n']);
  });

  it('R12.3 end to end: the real hook script (from the --settings JSON) snapshots before the prompt', async () => {
    const panel = fakePanel('claude', 'panel-7');
    const rt = await load({ panels: [panel], withHook: true });
    await rt.ctx.supportScripts.whenInstalled();
    const plan = await rt.ctx.spawn.resolve(spawnCtx('claude'));
    const settings = JSON.parse(plan.args.find((a) => a.startsWith('--settings='))!.slice('--settings='.length));
    const hook = settings.hooks.UserPromptSubmit[0].hooks[0];
    const input = JSON.stringify({ session_id: 's', hook_event_name: 'UserPromptSubmit', cwd: rt.vault, prompt: 'make this shorter' });
    const env = { ...process.env, ...plan.env };
    // Hook runs while the event loop keeps serving the bridge: spawn asynchronously.
    const result = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
      const child = spawn('/bin/sh', ['-c', hook.command], { env });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d));
      child.stderr.on('data', (d: Buffer) => (err += d));
      child.on('close', (code) => done({ code, out, err }));
      child.stdin.end(input);
    });
    expect(result).toEqual({ code: 0, out: '', err: '' });
    const [snap] = await rt.service.list();
    expect(snap!.subject).toMatch(/^Before Claude Code: "make this shorter" — /);
    expect(snap!.panelId).toBe('panel-7');
  });
});

describe('Claude --settings contributor (R11.1)', () => {
  it('adds --settings=<json> with the UserPromptSubmit hook and the panel / bridge env for Claude only', async () => {
    const rt = await load();
    const server = rt.ctx.services.require('bridgeServer');
    const plan = await rt.ctx.spawn.resolve(spawnCtx('claude', ['--model', 'sonnet']));
    expect(plan.args.slice(0, 2)).toEqual(['--model', 'sonnet']);
    expect(plan.args.some((a) => a.startsWith('--mcp-config='))).toBe(true);
    const flag = plan.args.find((a) => a.startsWith('--settings='))!;
    const hookPath = join(homedir(), '.config', 'obsidian-ai-terminal', 'snapshot_hook.py');
    expect(JSON.parse(flag.slice('--settings='.length))).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `/usr/bin/python3 -I ${hookPath}`, timeout: 15 }] }] },
    });
    expect(plan.env).toMatchObject({ [PANEL_ID_ENV]: 'panel-7', OBSIDIAN_BRIDGE_URL: server.baseUrl, OBSIDIAN_BRIDGE_TOKEN: TOKEN });
    expect(plan.args.join(' ')).not.toContain(TOKEN);
    for (const p of ['agy', 'shell'] as const) {
      const other = await rt.ctx.spawn.resolve(spawnCtx(p));
      expect(other.args.some((a) => a.startsWith('--settings'))).toBe(false);
      expect(other.env[PANEL_ID_ENV]).toBeUndefined();
    }
    // No Claude config was written.
    for (const f of ['.claude.json', '.claude']) expect(existsSync(join(homedir(), f))).toBe(false);
  });

  it('no hook when snapshots are off, the bridge is off, or the user passes their own --settings', async () => {
    const off = await load({ enabled: false });
    expect((await off.ctx.spawn.resolve(spawnCtx('claude'))).args.some((a) => a.startsWith('--settings'))).toBe(false);
    const noBridge = await load({ bridgeEnabled: false });
    expect((await noBridge.ctx.spawn.resolve(spawnCtx('claude'))).args.some((a) => a.startsWith('--settings'))).toBe(false);
    const own = await load();
    const plan = await own.ctx.spawn.resolve(spawnCtx('claude', ['--settings', '/my/settings.json']));
    expect(plan.args.filter((a) => a.startsWith('--settings'))).toEqual(['--settings']);
    expect(plan.notices).toContain(USER_SETTINGS_NOTICE);
    expect(hasSettingsArg(['--settings={}'])).toBe(true);
    expect(hasSettingsArg(['--setting-sources', 'user'])).toBe(false);
  });

  it('the hook command survives paths with spaces and quotes (sh -c)', () => {
    const dir = join(tempDir('hook path-'), "it's here");
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, 'ran');
    const script = join(dir, 'fake hook.py');
    writeFileSync(script, `open(${JSON.stringify(marker)}, "w").write("ok")\n`);
    const command = JSON.parse(claudeHookSettings('/usr/bin/python3', script)).hooks.UserPromptSubmit[0].hooks[0].command;
    expect(spawnSync('/bin/sh', ['-c', command]).status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('ok');
    expect(shellQuote('/usr/bin/python3')).toBe('/usr/bin/python3');
    expect(shellQuote("a b'c")).toBe(`'a b'\\''c'`);
  });
});

describe('agy Enter interceptor (R12.7, R12.15)', () => {
  const interceptor = (rt: Runtime) => {
    const list = rt.ctx.keyboard.enterInterceptors();
    expect(list).toHaveLength(1);
    return list[0]!;
  };

  it('returns at once for other profiles and when nothing changed', async () => {
    const rt = await load();
    const run = interceptor(rt);
    for (const p of ['claude', 'shell'] as const) expect(run(fakePanel(p))).toBeUndefined();
    (rt.service as unknown as { flag: { clear(): void } }).flag.clear();
    expect(run(fakePanel('agy'))).toBeUndefined();
    const off = await load({ enabled: false });
    expect(interceptor(off)(fakePanel('agy'))).toBeUndefined();
    expect(existsSync(rt.service.storePath)).toBe(false);
  });

  it('holds until the snapshot is committed when it is fast', async () => {
    const rt = await load();
    const panel = fakePanel('agy', 'agy-9');
    await interceptor(rt)(panel);
    const [snap] = await rt.service.list();
    expect(snap!.subject).toMatch(/^Before input in Antigravity — /);
    expect(snap).toMatchObject({ ai: 'agy', kind: 'prompt', panelId: 'agy-9' });
    expect(panel.printed).toEqual([]);
    expect(panel.sent).toEqual([]);
  });

  it('a slow snapshot releases after the wait with the "still running" note', async () => {
    const rt = await load({ agyWaitMs: 200, gitPath: gitWrapper({ sleepOn: { commands: ['commit'], seconds: 1 } }) });
    const panel = fakePanel('agy');
    const started = Date.now();
    await interceptor(rt)(panel);
    expect(Date.now() - started).toBeLessThan(800);
    expect(panel.printed).toEqual([`\r\n${NOTES.pendingAgy}\r\n`]);
    expect(panel.sent).toEqual([]);
    await rt.service.whenIdle();
    expect(await rt.service.list()).toHaveLength(1);
  });

  it('uses 2 s by default', async () => {
    const { AGY_WAIT_MS } = await import('../../src/snapshot/agyEnterHold');
    const { HOOK_WAIT_MS } = await import('../../src/snapshot/endpoint');
    const { SPAWN_WAIT_MS } = await import('../../src/snapshot/spawnSnapshot');
    expect([AGY_WAIT_MS, HOOK_WAIT_MS, SPAWN_WAIT_MS]).toEqual([2000, 10_000, 10_000]);
  });
});
