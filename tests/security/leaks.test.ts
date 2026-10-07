// @vitest-environment happy-dom
// R15.1 — token-leak audit. Boots the whole plugin (every real feature module from main.ts; only the PTY is fake, agy is
// a fake executable and git a pass-through wrapper that can be told to fail), opens Claude / Antigravity / shell panels,
// drives the HTTP bridge, the IDE connection, the agy MCP shim, the snapshot hook, snapshots and their failures, the
// restore dialog and the settings, and records every log line, Notice, panel print, argv, HTTP / WebSocket answer,
// subprocess output, commit message, saved setting and file. Neither token may appear in any of them — raw,
// URL-encoded, base64 or as a 16-character fragment. Tokens are allowed only where they must be: the bridge token in
// the environment of Claude / agy panels, the IDE token in `~/.claude/ide/<port>.lock` (mode 0600).
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import type { App } from 'obsidian';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FeatureModule, PluginContext } from '../../src/core/types';
import AiTerminalPlugin from '../../src/main';
import { TerminalMirror } from '../../src/session/mirror';
import type { TerminalView } from '../../src/terminal/TerminalView';
import { setDebugLogging } from '../../src/util/log';
import { createFakeAgy, type FakeAgy } from '../agy/fakeAgy';
import { createBridgeEnv, type BridgeEnv } from '../bridge/helpers';
import { connect } from '../ide/helpers';
import { createManifest, Modal, Notice } from '../mocks/obsidian';
import { FakePtyService, sleep, waitFor } from '../session/helpers';
import { bufferText, stubFit } from '../terminal/helpers';

// ------------------------------------------------------------------ the whole plugin, with a fake PTY and a git wrapper

const H = vi.hoisted(() => ({ gitPath: '', ptyModule: null as null | (() => unknown) }));

vi.mock('../../src/pty/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/pty/index')>()),
  createPtyModule: () => H.ptyModule!(),
}));

vi.mock('../../src/snapshot/index', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/snapshot/index')>();
  return { ...orig, createSnapshotModule: () => orig.createSnapshotModule({ gitPath: H.gitPath }) };
});

const PYTHON = '/usr/bin/python3';
const SRC = resolve(__dirname, '../../src');
const pty = new FakePtyService();
H.ptyModule = (): FeatureModule => ({
  id: 'pty',
  register(ctx) {
    ctx.services.provide('python', { resolve: async () => PYTHON, current: () => PYTHON, invalidate() {} });
    ctx.services.provide('pty', pty);
  },
});

// ------------------------------------------------------------------ captured output

const logs: string[] = [];
const httpAnswers: string[] = [];
const wsMessages: string[] = [];
const subprocessOutput: string[] = [];
/** Everything shown in any panel (prints and program output): every write goes through the session's mirror. */
const panelChunks: string[] = [];
const decoder = new TextDecoder();

function panelOutput(): string {
  return panelChunks.join('');
}

// ------------------------------------------------------------------ secrets

let bridgeToken = '';
let ideToken = '';

/** Every form of a token that must not appear: raw, URL-encoded, base64, and a 16-character fragment of either end. */
function secretForms(): Array<[string, string]> {
  const forms: Array<[string, string]> = [];
  for (const [name, t] of [['bridge token', bridgeToken], ['IDE token', ideToken]] as const) {
    forms.push([`${name}`, t], [`${name} (URL-encoded)`, encodeURIComponent(t)], [`${name} (base64)`, Buffer.from(t).toString('base64')]);
    forms.push([`${name} (first 16 chars)`, t.slice(0, 16)], [`${name} (last 16 chars)`, t.slice(-16)]);
  }
  return forms;
}

/** Names of the token forms found in `text` (empty = clean). */
function leaks(text: string): string[] {
  return secretForms()
    .filter(([, form]) => text.includes(form))
    .map(([name]) => name);
}

function expectClean(label: string, texts: string | readonly string[]): void {
  const list = typeof texts === 'string' ? [texts] : texts;
  const found = list.flatMap((t, i) => leaks(t).map((l) => `${label}[${i}]: ${l}`));
  expect(found, `${label} must not contain a token`).toEqual([]);
}

// ------------------------------------------------------------------ helpers

function request(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        httpAnswers.push(`${method} ${new URL(url).pathname} → ${res.statusCode} ${JSON.stringify(res.headers)} ${text}`);
        done({ status: res.statusCode ?? 0, text });
      });
    });
    req.on('error', fail);
    req.end(body);
  });
}

/** Runs a process asynchronously (the bridge it talks to lives in this process, so spawnSync would deadlock). */
function run(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; input?: string }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', fail);
    child.on('close', (code) => {
      const r = { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
      subprocessOutput.push(`${[cmd, ...args].join(' ')}\n${r.stdout}\n${r.stderr}`, [cmd, ...args].join('\0'));
      done(r);
    });
    child.stdin.end(opts.input ?? '');
  });
}

function rpc(id: number | null, method: string, params?: unknown): string {
  return JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params });
}

/** A pass-through wrapper around /usr/bin/git whose `commit` fails with the contents of `flagFile` (when not empty). */
function writeGitWrapper(dir: string, flagFile: string): string {
  const file = join(dir, 'git');
  const script = [
    '#!/bin/bash',
    'sub=""; skip=0',
    'for a in "$@"; do',
    '  if [ $skip = 1 ]; then skip=0; continue; fi',
    '  case "$a" in -c) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac',
    'done',
    `if [ "$sub" = commit ] && [ -s '${flagFile}' ]; then echo "fatal: unable to write commit: $(cat '${flagFile}')" >&2; exit 128; fi`,
    'exec /usr/bin/git "$@"',
    '',
  ];
  writeFileSync(file, script.join('\n'));
  chmodSync(file, 0o755);
  return file;
}

/** Regular files under `dirs` (symlinks are not followed) that contain a token form. */
function scanFiles(dirs: readonly string[]): Array<{ file: string; forms: string[] }> {
  const hits: Array<{ file: string; forms: string[] }> = [];
  const walk = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
    } else if (st.isFile() && st.size < 8 * 1024 * 1024) {
      const forms = leaks(readFileSync(p).toString('latin1'));
      if (forms.length) hits.push({ file: p, forms });
    }
  };
  for (const d of dirs) walk(d);
  return hits;
}

// ------------------------------------------------------------------ fixture

let vault: string;
let tools: string;
let flagFile: string;
let agyEnvLog: string;
let agyLockModes: string;
let fakeAgy: FakeAgy;
let env: BridgeEnv;
let plugin: AiTerminalPlugin;
let ctx: PluginContext;
let note: ReturnType<BridgeEnv['addNote']>;
const views: Record<'claude' | 'agy' | 'shell', TerminalView | null> = { claude: null, agy: null, shell: null };

function touchNote(text: string): void {
  writeFileSync(join(vault, 'Notes', 'X.md'), `one\ntwo\nthree\n${text}\n`);
  ctx.services.require('snapshots').markChanged('test');
}

let storePath = '';

function storeGit(args: string[]): string {
  return execFileSync('/usr/bin/git', [`--git-dir=${storePath}`, `--work-tree=${vault}`, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function commitMessages(): string[] {
  const raw = storeGit(['log', '--all', '--format=%H%n%B%x00']);
  return raw.split('\0').map((m) => m.trim()).filter(Boolean);
}

function call(profile: 'claude' | 'agy' | 'shell') {
  const command = ctx.settings.profiles[profile].command;
  const found = pty.calls.find((c) => c.command === command);
  if (!found) throw new Error(`no ${profile} spawn`);
  return found;
}

function panelId(profile: 'claude' | 'agy' | 'shell'): string {
  const id = views[profile]?.panelId;
  if (!id) throw new Error(`no ${profile} panel`);
  return id;
}

beforeAll(async () => {
  setDebugLogging(true);
  for (const level of ['debug', 'info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 6 }))).join(' '));
    });
  }
  // Own arrays, not `mock.calls`: vitest clears mock calls before every test.
  const mirrorWrite = TerminalMirror.prototype.write;
  vi.spyOn(TerminalMirror.prototype, 'write').mockImplementation(function (this: TerminalMirror, data: string | Uint8Array) {
    panelChunks.push(typeof data === 'string' ? data : decoder.decode(data));
    mirrorWrite.call(this, data);
  });
  stubFit();
  Notice.clear();

  vault = mkdtempSync(join(tmpdir(), 'vault-'));
  mkdirSync(join(vault, 'Notes'), { recursive: true });
  writeFileSync(join(vault, 'Notes', 'X.md'), 'one\ntwo\nthree\n');
  writeFileSync(join(vault, 'Notes', 'Y.md'), 'links to [[X]]\n');
  const pluginDir = join(vault, '.obsidian', 'plugins', 'obsidian-ai-terminal');
  mkdirSync(pluginDir, { recursive: true });
  for (const f of ['pty/pty_bridge.py', 'bridge/mcp_shim.py', 'snapshot/snapshot_hook.py']) copyFileSync(join(SRC, f), join(pluginDir, f.split('/')[1]!));

  tools = mkdtempSync(join(tmpdir(), 'leak-tools-'));
  flagFile = join(tools, 'git-fail-with');
  H.gitPath = writeGitWrapper(tools, flagFile);
  fakeAgy = createFakeAgy(join(tools, 'fake-agy'));
  agyEnvLog = join(tools, 'agy-env.log');
  const agyWrapper = join(tools, 'agy-wrapper', 'agy');
  mkdirSync(dirname(agyWrapper));
  // Logs argv + environment of every `agy mcp …` call, and the mode of the agy lock file the plugin holds meanwhile.
  agyLockModes = join(tools, 'agy-lock-modes.log');
  const agyLock = join(homedir(), '.config', 'obsidian-ai-terminal', 'agy-config.lock');
  writeFileSync(
    agyWrapper,
    `#!/bin/bash\n{ printf '%s\\n' "$*"; env; echo ---; } >> '${agyEnvLog}'\nstat -f '%Lp' '${agyLock}' >> '${agyLockModes}'\nexec '${fakeAgy.path}' "$@"\n`,
  );
  chmodSync(agyWrapper, 0o755);

  env = createBridgeEnv(vault);
  plugin = new AiTerminalPlugin(env.obsidianApp as App, createManifest() as never);
  (plugin as unknown as { data: unknown }).data = {
    snapshots: { enabled: true },
    profiles: { agy: { command: agyWrapper, args: '' } },
  };
  await plugin.onload();
  ctx = plugin.context!;
  await ctx.ready;

  storePath = ctx.services.require('snapshots').storePath;
  bridgeToken = ctx.services.require('bridgeServer').token;
  const lockFile = ctx.services.require('ide').lockFilePath!;
  ideToken = (JSON.parse(readFileSync(lockFile, 'utf8')) as { authToken: string }).authToken;

  note = env.addNote('Notes/X.md', 'one\ntwo\nthree\n');
  env.focus(note.leaf);
  note.editor.setSelection({ line: 1, ch: 0 }, { line: 2, ch: 5 });
}, 60_000);

afterAll(() => {
  if (plugin?.context) plugin.onunload();
  for (const m of [...Modal.open]) m.close();
  setDebugLogging(false);
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ the audit

describe('R15.1: tokens never leak', () => {
  it('the plugin loaded with both servers and two distinct per-run tokens', () => {
    expect(ctx.services.require('bridgeServer').isRunning()).toBe(true);
    expect(ctx.services.require('ide').isRunning()).toBe(true);
    expect(bridgeToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(ideToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridgeToken).not.toBe(ideToken);
    // Nothing put a token into Obsidian's own environment (every child process would inherit it).
    expectClean('process.env', Object.values(process.env).map(String));
  });

  it('spawns: the bridge token is only in the environment of Claude / agy panels, never in any argv', async () => {
    const terminals = ctx.services.require('terminals');
    for (const profile of ['claude', 'agy', 'shell'] as const) {
      const view = await terminals.open(profile);
      expect(view).not.toBeNull();
      views[profile] = view;
      await waitFor(() => view!.session?.state === 'running', 15_000);
    }
    for (const c of pty.calls) expectClean(`argv of ${c.command}`, [c.command, ...(c.args ?? [])].join('\0'));

    const claude = call('claude');
    expect(claude.env?.OBSIDIAN_BRIDGE_TOKEN).toBe(bridgeToken);
    // The MCP config only names the variable; Claude Code expands it from its environment.
    expect(claude.args?.find((a) => a.startsWith('--mcp-config='))).toContain('Bearer ${OBSIDIAN_BRIDGE_TOKEN}');
    expect(claude.args).toContain('--ide');
    expect(claude.args?.some((a) => a.startsWith('--settings='))).toBe(true);
    expect(call('agy').env?.OBSIDIAN_BRIDGE_TOKEN).toBe(bridgeToken);

    const shell = call('shell');
    expect(shell.env?.OBSIDIAN_BRIDGE_TOKEN).toBeUndefined();
    const shellEnv = ctx.services.require('shellEnv').getSpawnEnv({ PWD: vault, ...shell.env });
    expectClean('shell panel environment', Object.values(shellEnv).map(String));
    // The IDE token travels only through the 0600 lock file — no panel environment carries it.
    for (const c of pty.calls) expect(Object.values(c.env ?? {}).join('\n')).not.toContain(ideToken);
  });

  it('HTTP bridge: wrong / missing / misplaced tokens get a fixed 401 that never echoes a token', async () => {
    const server = ctx.services.require('bridgeServer');
    const mcp = server.url!;
    const base = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const refused: Array<Record<string, string>> = [
      {},
      { Authorization: 'Bearer 00000000-0000-4000-8000-000000000000' },
      { Authorization: `Basic ${bridgeToken}` },
      { Authorization: `Bearer ${bridgeToken}x` },
      { Authorization: `Bearer ${ideToken}` },
      { 'X-Claude-Code-Ide-Authorization': ideToken },
    ];
    for (const h of refused) expect((await request('POST', mcp, { ...base, ...h }, rpc(1, 'tools/list'))).status).toBe(401);
    expect((await request('POST', `${mcp}?token=${bridgeToken}`, base, rpc(1, 'tools/list'))).status).toBe(401);
    expect((await request('POST', `${server.baseUrl}/snapshot`, base, '{"panelId":"x"}')).status).toBe(401);

    const auth = { ...base, Authorization: `Bearer ${bridgeToken}` };
    expect((await request('POST', mcp, auth, rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }))).status).toBe(200);
    const list = await request('POST', mcp, auth, rpc(2, 'tools/list'));
    expect(JSON.parse(list.text).result.tools).toHaveLength(5);
    for (const [id, name, args] of [
      [3, 'get_active_note', {}],
      [4, 'get_selection', {}],
      [5, 'open_note', { path: '../outside.md' }],
      [6, 'get_links', { path: 'missing.md' }],
      [7, 'nonexistent_tool', {}],
    ] as const) {
      expect((await request('POST', mcp, auth, rpc(id, 'tools/call', { name, arguments: args }))).status).toBe(200);
    }
    expect((await request('POST', mcp, auth, '{not json')).status).toBe(400);
    expect((await request('GET', mcp, auth)).status).toBe(405);
    expect((await request('GET', `${server.baseUrl}/nothing-here`, auth)).status).toBe(404);
    expectClean('HTTP answers', httpAnswers);
  });

  it('IDE connection: refused upgrades and every message to Claude carry no token', async () => {
    const port = ctx.services.require('ide').port!;
    for (const token of [null, 'wrong', bridgeToken, `${ideToken}x`]) {
      expect(await connect(port, token)).toMatchObject({ ok: false, status: 401 });
    }
    const r = await connect(port, ideToken);
    if (!r.ok) throw new Error(r.error);
    const client = r.client;
    await client.handshake();
    const selection = await client.next((m) => m.method === 'selection_changed', 5_000);
    expect(selection.params.text).toBe('two\nthree');
    await client.request('tools/list');
    await client.request('tools/call', { name: 'openDiff', arguments: { old_file_path: '/x', new_file_contents: 'y' } });
    await client.request('no/such/method');
    client.send('{broken');
    await client.next((m) => m.error?.code === -32700);
    wsMessages.push(...client.messages.map((m) => JSON.stringify(m)));
    await client.close();
    expectClean('IDE messages', wsMessages);
  });

  it('agy MCP shim: answers and errors (right token, wrong token, no bridge, dead bridge) never contain a token', async () => {
    const shim = ctx.services.require('agyBridge').shimPath;
    expect(existsSync(shim)).toBe(true);
    const input =
      [
        rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agy', version: '1.3.0' } }),
        rpc(null, 'notifications/initialized'),
        rpc(2, 'tools/list'),
        rpc(3, 'tools/call', { name: 'get_selection', arguments: {} }),
        rpc(4, 'tools/call', { name: 'open_note', arguments: { path: '/etc/passwd' } }),
      ].join('\n') + '\n';
    const baseEnv = { PATH: '/usr/bin:/bin', HOME: homedir() };
    const bridgeUrl = ctx.services.require('bridgeServer').baseUrl!;
    const wrongToken = 'wrong-token-0123456789abcdef';
    const cases = {
      good: { ...baseEnv, OBSIDIAN_BRIDGE_URL: bridgeUrl, OBSIDIAN_BRIDGE_TOKEN: bridgeToken },
      wrong: { ...baseEnv, OBSIDIAN_BRIDGE_URL: bridgeUrl, OBSIDIAN_BRIDGE_TOKEN: wrongToken },
      offline: baseEnv,
      dead: { ...baseEnv, OBSIDIAN_BRIDGE_URL: 'http://127.0.0.1:9', OBSIDIAN_BRIDGE_TOKEN: bridgeToken },
    };
    const results: Record<string, Array<Record<string, any>>> = {};
    for (const [name, e] of Object.entries(cases)) {
      const r = await run(PYTHON, ['-I', shim], { env: e, input });
      expect(r.code, name).toBe(0);
      expect(r.stderr, name).toBe('');
      expectClean(`shim (${name})`, r.stdout);
      expect(r.stdout).not.toContain(wrongToken);
      results[name] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    }
    expect(results.good!.find((m) => m.id === 2)!.result.tools).toHaveLength(5);
    expect(results.wrong!.find((m) => m.id === 2)!.error.message).toMatch(/HTTP 401/);
    expect(results.offline!.find((m) => m.id === 2)!.result.tools).toEqual([]);
    expect(results.dead!.find((m) => m.id === 2)!.error.message).toMatch(/not reachable/);
  });

  it('snapshot hook: prints nothing, and commit messages / prompt excerpts hold only [REDACTED]', async () => {
    const claude = call('claude');
    const settingsArg = claude.args!.find((a) => a.startsWith('--settings='))!;
    const hookCommand: string = JSON.parse(settingsArg.slice('--settings='.length)).hooks.UserPromptSubmit[0].hooks[0].command;
    expectClean('hook command', hookCommand);
    // Claude Code runs the hook with `sh -c` and the session's environment.
    const hookEnv = { PATH: '/usr/bin:/bin', HOME: homedir(), ...claude.env };
    const runHook = (prompt: string) =>
      run('/bin/sh', ['-c', hookCommand], { env: hookEnv, input: JSON.stringify({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt }) });

    const before = commitMessages().length;
    touchNote('edit 1');
    const r1 = await runHook(`make this shorter ${bridgeToken} / ${encodeURIComponent(ideToken)} / ${ideToken}`);
    touchNote('edit 2');
    // The token straddles the 200-character prompt limit (redacted before the cut, not after).
    const r2 = await runHook(`${'y'.repeat(190)}${bridgeToken} tail`);
    for (const r of [r1, r2]) expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);

    const messages = commitMessages();
    expect(messages.length).toBe(before + 2);
    expect(messages.some((m) => m.includes('Before Claude Code: "make this shorter [REDACTED] / [REDACTED] / [REDACTED]"'))).toBe(true);
    expect(messages.some((m) => m.includes(`Prompt: "${'y'.repeat(190)}[REDACTED]"`))).toBe(true);
    expectClean('commit messages', messages);
    const excerpts = (await ctx.services.require('snapshots').list()).map((s) => `${s.subject}\n${s.promptExcerpt ?? ''}`);
    expectClean('snapshot list', excerpts);
  });

  it('failure paths: git errors, spawn errors and notices that contain a token are redacted in panels, logs and Notices', async () => {
    const sessions = ctx.services.require('sessions');
    // git now fails every commit with a message that contains both tokens.
    writeFileSync(flagFile, `${bridgeToken} ${ideToken}`);
    const gitFailure = 'unable to write commit: [REDACTED] [REDACTED]';

    // 1. Spawn-time snapshot of a restarted Claude panel.
    touchNote('edit 3');
    await sessions.restart(panelId('claude'));
    await waitFor(() => views.claude!.session?.state === 'running', 15_000);
    expect(panelOutput()).toContain(`[Snapshot failed: ${gitFailure} — starting without a restore point]`);

    // 2. The Claude hook → /snapshot → note printed in the Claude panel.
    touchNote('edit 4');
    const claude = pty.calls.filter((c) => c.command === 'claude').at(-1)!;
    const settingsArg = claude.args!.find((a) => a.startsWith('--settings='))!;
    const hookCommand: string = JSON.parse(settingsArg.slice('--settings='.length)).hooks.UserPromptSubmit[0].hooks[0].command;
    const r = await run('/bin/sh', ['-c', hookCommand], { env: { PATH: '/usr/bin:/bin', HOME: homedir(), ...claude.env }, input: '{"prompt":"x"}' });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    await waitFor(() => panelOutput().includes(`[Snapshot failed: ${gitFailure} — this message is not protected]`), 5_000);

    // 3. Enter in the agy panel (T4 runs the interceptors).
    touchNote('edit 5');
    const agy = sessions.get(panelId('agy'))!;
    await Promise.all(ctx.keyboard.enterInterceptors().map((fn) => fn(agy)));
    expect(panelOutput().split(`[Snapshot failed: ${gitFailure} — this message is not protected]`).length).toBe(3);

    // 4. Turning snapshots off and on: the first-snapshot failure is a Notice.
    touchNote('edit 6');
    ctx.settings.snapshots.enabled = false;
    await ctx.saveSettings();
    ctx.settings.snapshots.enabled = true;
    await ctx.saveSettings();
    await waitFor(() => Notice.shown.some((n) => n.message.includes('first snapshot of this vault failed')), 10_000);
    expect(Notice.shown.find((n) => n.message.includes('first snapshot'))!.message).toContain(gitFailure);
    await ctx.services.require('snapshots').whenIdle();
    rmSync(flagFile);

    // 5. The shell program could not be run (the reason and the helper's stderr name a token).
    const shellProc = pty.spawned.find((p) => p.command === ctx.settings.profiles.shell.command && !p.hasExited)!;
    shellProc.exit(126, { execError: { message: `EACCES: permission denied ${bridgeToken}`, errno: 13, code: 'EACCES' }, stderr: `helper: ${ideToken}` });
    await waitFor(() => panelOutput().includes('EACCES: permission denied [REDACTED]'), 5_000);

    // 6. Any notice / beforeSpawn line / start failure that names a token (no current contributor does; the panel redacts).
    const disposeContributor = ctx.spawn.add('t11-probe', (c) => (c.profile === 'shell' ? { notice: `probe notice ${bridgeToken}` } : undefined));
    const disposeHook = ctx.sessionEvents.beforeSpawn((b) => {
      if (b.profile === 'shell') b.print(`probe line ${ideToken}`);
    });
    pty.failWith = new Error(`helper failed to start ${ideToken} ${encodeURIComponent(bridgeToken)}`);
    await sessions.restart(panelId('shell'));
    await waitFor(() => panelOutput().includes('helper failed to start [REDACTED] [REDACTED]'), 5_000);
    pty.failWith = null;
    await sessions.restart(panelId('shell'));
    await waitFor(() => views.shell!.session?.state === 'running', 5_000);
    disposeContributor();
    disposeHook();
    expect(panelOutput()).toContain('probe notice [REDACTED]');
    expect(panelOutput()).toContain('probe line [REDACTED]');
    // The redacted failures were also logged — with [REDACTED] in place of the tokens.
    expect(logs.some((l) => l.includes('could not start Shell: helper failed to start [REDACTED] [REDACTED]'))).toBe(true);
    expect(logs.some((l) => l.includes(`snapshot failed: ${gitFailure}`))).toBe(true);
    expectClean('panel output', panelOutput());
  });

  it('restore dialog: the snapshot list and the file step show no token', async () => {
    const commands = (plugin as unknown as { commands: Array<{ id: string; callback?: () => unknown }> }).commands;
    const command = commands.find((c) => c.id === 'obsidian-ai-terminal:restore-notes')!;
    command.callback!();
    const modal = Modal.open.at(-1)!;
    const content = modal.contentEl as HTMLElement;
    await vi.waitFor(() => expect(content.querySelectorAll('.ai-terminal-restore-snapshot').length).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    await vi.waitFor(() => expect(content.querySelector('.ai-terminal-restore-count')?.textContent).toMatch(/changed since|no changes/), { timeout: 10_000 });
    const listText = (modal.modalEl as HTMLElement).textContent ?? '';
    expect(listText).toContain('[REDACTED]');
    (content.querySelector('.ai-terminal-restore-snapshot') as HTMLElement).click();
    await vi.waitFor(() => expect(content.querySelector('.ai-terminal-restore-file')).not.toBeNull(), { timeout: 10_000 });
    const filesText = (modal.modalEl as HTMLElement).textContent ?? '';
    modal.close();
    expectClean('restore dialog', [listText, filesText]);
  });

  it('settings: toggling the agy bridge and the bridge, the settings tab and data.json carry no token', async () => {
    ctx.settings.agyBridgeEnabled = false;
    await ctx.saveSettings();
    await waitFor(() => fakeAgy.mcpCalls('remove').length === 1, 10_000);
    ctx.settings.agyBridgeEnabled = true;
    await ctx.saveSettings();
    await waitFor(() => fakeAgy.mcpCalls('add').length === 2, 10_000);
    await waitFor(() => !existsSync(join(homedir(), '.config', 'obsidian-ai-terminal', 'agy-config.lock')), 10_000);
    ctx.settings.bridgeEnabled = false;
    await ctx.saveSettings();
    ctx.settings.bridgeEnabled = true;
    await ctx.saveSettings();
    await ctx.services.require('bridgeServer').whenListening();

    // argv and environment of every `agy mcp …` call the plugin made.
    expect(fakeAgy.mcpCalls('add')[0]).toEqual(['mcp', 'add', 'obsidian', '--', PYTHON, ctx.services.require('agyBridge').shimPath]);
    expectClean('agy argv', fakeAgy.calls().map((c) => c.args.join('\0')));
    expectClean('agy environment', readFileSync(agyEnvLog, 'utf8'));

    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void; containerEl: HTMLElement }> }).settingTabs[0]!;
    tab.display();
    expectClean('settings tab', tab.containerEl.textContent ?? '');

    const saved = (plugin as unknown as { data: { moduleData: Record<string, unknown> } }).data;
    // The one-time Diff tool hint is the only module state; it was saved (so moduleData was written at least once).
    expect(saved.moduleData).toEqual({ ide: { diffHintShown: true } });
    expectClean('data.json', JSON.stringify(saved));
  });

  it('files: only ~/.claude/ide/<port>.lock (0600) holds a token — the IDE token; lock files are 0600', () => {
    const lockFile = ctx.services.require('ide').lockFilePath!;
    expect(statSync(lockFile).mode & 0o777).toBe(0o600);
    const hits = scanFiles([homedir(), vault, tools]);
    expect(hits).toEqual([{ file: lockFile, forms: ['IDE token', 'IDE token (URL-encoded)', 'IDE token (first 16 chars)', 'IDE token (last 16 chars)'] }]);
    // Support scripts and the agy lock file (if it is left over) are not secret, and not writable by others.
    const support = join(homedir(), '.config', 'obsidian-ai-terminal');
    for (const name of ['mcp_shim.py', 'snapshot_hook.py']) expect(statSync(join(support, name)).mode & 0o022).toBe(0);
    // The agy lock file exists only while `agy mcp …` runs; its mode was recorded then.
    const modes = readFileSync(agyLockModes, 'utf8').trim().split('\n');
    expect(modes.length).toBeGreaterThanOrEqual(4);
    expect(new Set(modes)).toEqual(new Set(['600']));
    expect(existsSync(join(support, 'agy-config.lock'))).toBe(false);
  });

  it('after unload: the lock file is gone, and no log line, Notice, panel text, argv or file contains a token', async () => {
    const lockFile = ctx.services.require('ide').lockFilePath!;
    const screens = Object.values(views).map((v) => (v?.terminal ? bufferText(v) : ''));
    plugin.onunload();
    await sleep(50);
    expect(existsSync(lockFile)).toBe(false);

    // Positive controls: the redaction paths above really ran and were captured.
    expect(logs.length).toBeGreaterThan(20);
    expect(logs.join('\n')).toContain('[REDACTED]');
    expect(panelOutput()).toContain('[REDACTED]');
    expect(Notice.shown.some((n) => n.message.includes('[REDACTED]'))).toBe(true);

    expectClean('log lines', logs);
    expectClean('Notices', Notice.shown.map((n) => n.message));
    expectClean('panel output', panelOutput());
    expectClean('terminal screens', screens);
    expectClean('PTY argv', pty.calls.map((c) => [c.command, ...(c.args ?? [])].join('\0')));
    expectClean('subprocess output', subprocessOutput);
    expectClean('HTTP answers', httpAnswers);
    expectClean('IDE messages', wsMessages);
    expectClean('commit messages', commitMessages());
    expectClean('data.json', JSON.stringify((plugin as unknown as { data: unknown }).data));
    expect(scanFiles([homedir(), vault, tools])).toEqual([]);
  });
});

describe('R15.1: source guards', () => {
  /** Files allowed to call `console.*` directly: the logger's default sink and default error reporters that the runtime
   * always replaces with the redacting logger (`core/runtime.ts`, `main.ts`). */
  const CONSOLE_ALLOWED = new Set(['util/log.ts', 'core/events.ts', 'core/spawn.ts', 'core/keyboard.ts', 'settings.ts']);

  function sources(dir = SRC, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) sources(p, out);
      else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('Notices and console output go through the redacting helpers of src/util/log.ts', () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const rel = file.slice(SRC.length + 1);
      const code = readFileSync(file, 'utf8');
      if (rel !== 'util/log.ts' && /new\s+Notice\s*\(/.test(code)) offenders.push(`${rel}: new Notice(…) — use notice()`);
      if (!CONSOLE_ALLOWED.has(rel) && /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/.test(code)) offenders.push(`${rel}: console.* — use ctx.log`);
    }
    expect(offenders).toEqual([]);
  });

  it('the default error reporters that print with console.* are always replaced by the logger at runtime', () => {
    const runtime = readFileSync(join(SRC, 'core/runtime.ts'), 'utf8');
    for (const cls of ['SpawnContributorRegistry', 'KeyboardHooks', 'SessionEvents']) expect(runtime).toMatch(new RegExp(`new ${cls}\\(report\\)`));
    expect(readFileSync(join(SRC, 'main.ts'), 'utf8')).toMatch(/new SettingsStore\(\s*\(data\) => this\.saveData\(data\),\s*\(err\) => log\.error/);
    for (const file of sources()) {
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(/new TypedEmitter(?:<[^>]*>)?\((.{0,60})/g)) {
        expect(m[1], `${file}: TypedEmitter without a logger error reporter`).toMatch(/^\(m, e\) => [\w.?]*log[\w.?]*\.error\(/);
      }
    }
  });
});
