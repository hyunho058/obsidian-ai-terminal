import { copyFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App, Plugin } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { PluginRuntime } from '../../src/core/runtime';
import { createEnvModule } from '../../src/env/index';
import {
  PtyCwdMissingError,
  PtyHelperMissingError,
  PythonNotFoundError,
  createPtyModule,
  formatSpawnFailure,
  type PtyModuleOptions,
  type PtyProcess,
} from '../../src/pty/index';
import type { ShellEnvOptions } from '../../src/env/shellEnv';
import { SettingsStore } from '../../src/settings';
import { createLogger, type LogSink } from '../../src/util/log';
import { createManifest, createMockApp, Notice, Plugin as MockPlugin } from '../mocks/obsidian';
import { HELPER_SOURCE, writeScript } from './helpers';

class TestPlugin extends MockPlugin {}

function sink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]) => lines.push(a.join(' '));
  return { lines, debug: push, info: push, warn: push, error: push };
}

async function makeRuntime(opts: { env?: ShellEnvOptions; pty?: PtyModuleOptions; withHelper?: boolean } = {}) {
  const pluginDir = mkdtempSync(join(tmpdir(), 'plugindir-'));
  if (opts.withHelper !== false) copyFileSync(HELPER_SOURCE, join(pluginDir, 'pty_bridge.py'));
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  const app = createMockApp(vault);
  const plugin = new TestPlugin(app, createManifest());
  const store = new SettingsStore((d) => plugin.saveData(d));
  store.load(null);
  const out = sink();
  const runtime = new PluginRuntime({
    app: app as unknown as App,
    plugin: plugin as unknown as Plugin,
    settingsStore: store,
    vaultPath: vault,
    pluginDir,
    log: createLogger(undefined, out),
  });
  await runtime.start([createEnvModule(opts.env), createPtyModule(opts.pty)]);
  return { runtime, ctx: runtime.ctx, vault, pluginDir, out };
}

async function outputOf(proc: PtyProcess): Promise<{ text: string; exitCode: number | null }> {
  const chunks: Uint8Array[] = [];
  proc.on('data', (c) => chunks.push(c));
  const exit = await proc.exited;
  return { text: Buffer.concat(chunks).toString('utf8'), exitCode: exit.exitCode };
}

beforeEach(() => Notice.clear());

describe('env + pty modules', () => {
  it('publish shellEnv / python / pty in register and finish capture + Python lookup in ready', async () => {
    const { runtime, ctx } = await makeRuntime();
    const shellEnv = ctx.services.require('shellEnv');
    const python = ctx.services.require('python');
    expect(ctx.services.has('pty')).toBe(true);
    expect(shellEnv.status).toBe('pending');
    await ctx.ready;
    expect(shellEnv.status).toBe('captured');
    expect(python.current()).toMatch(/python3/);
    expect(Notice.shown).toEqual([]);
    runtime.unload();
  });

  it('spawns a program in the vault with the layered environment (R2.1, R3.2)', async () => {
    const { runtime, ctx, vault } = await makeRuntime();
    await ctx.ready;
    const pty = ctx.services.require('pty');
    const proc = await pty.spawn({
      command: '/bin/sh',
      args: ['-c', 'echo "T=$TERM C=$COLORTERM P=$TERM_PROGRAM X=$EXTRA D=$PWD R=$(pwd -P)"; exit 3'],
      cwd: vault,
      cols: 90,
      rows: 20,
      env: { EXTRA: 'from-plan' },
    });
    expect(pty.live()).toContain(proc);
    const { text, exitCode } = await outputOf(proc);
    expect(exitCode).toBe(3);
    expect(text).toContain(`T=xterm-256color C=truecolor P=obsidian-ai-terminal X=from-plan D=${vault} R=${realpathSync(vault)}`);
    expect(pty.live()).toEqual([]);
    runtime.unload();
  });

  it('reports a missing command through the exit event (R3.4)', async () => {
    const { runtime, ctx, vault } = await makeRuntime();
    await ctx.ready;
    const proc = await ctx.services.require('pty').spawn({ command: 'claudex', cwd: vault, cols: 80, rows: 24 });
    const exit = await proc.exited;
    expect(formatSpawnFailure(exit)).toBe('Command not found: claudex — check Settings › Profiles');
    runtime.unload();
  });

  it('rejects without spawning when no Python works (R2.5)', async () => {
    const { runtime, ctx, vault } = await makeRuntime({ pty: { probe: async () => ({ error: 'broken' }) } });
    await ctx.ready;
    const pty = ctx.services.require('pty');
    const err = await pty.spawn({ command: '/bin/sh', cwd: vault, cols: 80, rows: 24 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PythonNotFoundError);
    expect((err as Error).message).toBe('Python 3 not found — install it or set the path in Settings');
    expect(pty.live()).toEqual([]);
    runtime.unload();
  });

  it('rejects when the helper or the working folder is missing', async () => {
    const { runtime, ctx, vault } = await makeRuntime({ withHelper: false });
    await ctx.ready;
    const pty = ctx.services.require('pty');
    await expect(pty.spawn({ command: '/bin/sh', cwd: vault, cols: 80, rows: 24 })).rejects.toBeInstanceOf(PtyHelperMissingError);
    runtime.unload();

    const second = await makeRuntime();
    await second.ctx.ready;
    await expect(
      second.ctx.services.require('pty').spawn({ command: '/bin/sh', cwd: join(second.vault, 'gone'), cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(PtyCwdMissingError);
    second.runtime.unload();
  });

  it('re-resolves Python when settings.pythonPath changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'custompy-'));
    const custom = writeScript(join(dir, 'mypython'), 'exec python3 "$@"\n');
    const { runtime, ctx } = await makeRuntime();
    await ctx.ready;
    const python = ctx.services.require('python');
    expect(python.current()).not.toBe(custom);
    ctx.settings.pythonPath = custom;
    await ctx.saveSettings();
    expect(python.current()).toBeUndefined();
    expect(await python.resolve()).toBe(custom);
    runtime.unload();
  });

  it('shows a Notice when the shell capture falls back (R3.3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badshell-'));
    mkdirSync(join(dir, 'h'));
    const shell = writeScript(join(dir, 'sh'), 'exit 1\n');
    const { runtime, ctx } = await makeRuntime({ env: { shell } });
    await ctx.ready;
    expect(ctx.services.require('shellEnv').status).toBe('fallback');
    expect(Notice.shown.map((n) => n.message)).toEqual([expect.stringMatching(/fallback PATH with ~\/\.local\/bin and \/opt\/homebrew\/bin/)]);
    runtime.unload();
  });

  it('kills live processes on unload (safety net)', async () => {
    const { runtime, ctx, vault } = await makeRuntime();
    await ctx.ready;
    const proc = await ctx.services.require('pty').spawn({ command: '/bin/sh', args: ['-c', 'echo up; sleep 600'], cwd: vault, cols: 80, rows: 24 });
    const chunks: string[] = [];
    proc.on('data', (c) => chunks.push(Buffer.from(c).toString()));
    while (!chunks.join('').includes('up')) await new Promise((r) => setTimeout(r, 20));
    runtime.unload();
    const exit = await proc.exited;
    expect(exit.killReason).toBe('plugin unload');
    expect(exit.exitCode).toBe(129);
  });
});
