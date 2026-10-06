// End-to-end through the real PTY helper: env + pty + session modules, tiny /bin/sh programs (never claude / agy).
import { copyFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App, Plugin } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginRuntime } from '../../src/core/runtime';
import { createEnvModule } from '../../src/env/index';
import { createPtyModule } from '../../src/pty/index';
import { createSessionModule } from '../../src/session/index';
import { exitPrompt, STOPPED_PROMPT } from '../../src/session/SessionRegistry';
import { SettingsStore } from '../../src/settings';
import { createLogger } from '../../src/util/log';
import { createManifest, createMockApp, Plugin as MockPlugin } from '../mocks/obsidian';
import { HELPER_SOURCE, isAlive } from '../pty/helpers';
import { FakeSink, waitFor } from './helpers';

class TestPlugin extends MockPlugin {}

let runtime: PluginRuntime | null = null;
afterEach(() => {
  runtime?.unload();
  runtime = null;
});

async function start() {
  const pluginDir = mkdtempSync(join(tmpdir(), 'plugindir-'));
  copyFileSync(HELPER_SOURCE, join(pluginDir, 'pty_bridge.py'));
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  const app = createMockApp(vault);
  const plugin = new TestPlugin(app, createManifest());
  const store = new SettingsStore((d) => plugin.saveData(d));
  store.load(null);
  runtime = new PluginRuntime({
    app: app as unknown as App,
    plugin: plugin as unknown as Plugin,
    settingsStore: store,
    vaultPath: vault,
    pluginDir,
    log: createLogger(undefined, { debug() {}, info() {}, warn() {}, error() {} }),
  });
  await runtime.start([createEnvModule({ shell: '/bin/sh' }), createPtyModule(), createSessionModule({ graceMs: 200, nudgeDelayMs: 5 })]);
  return { ctx: runtime.ctx, vault, sessions: runtime.ctx.services.require('sessions') };
}

describe('sessions over the real PTY helper', () => {
  it('runs the profile in the vault, shows the exit prompt and restarts on Enter (R1.6, R5.1, R5.2)', async () => {
    const { ctx, vault, sessions } = await start();
    ctx.settings.profiles.shell = { command: '/bin/sh', args: `-c 'printf "cwd=%s size=%s\\n" "$(pwd -P)" "$(stty size)"; exit 3'` };
    const sink = new FakeSink();
    sink.size = { cols: 77, rows: 21 };
    sessions.attach({ panelId: 'p1', profile: 'shell', phase: 'new', sink });
    await waitFor(() => sink.text().includes(exitPrompt(3)), 15_000);
    expect(sink.text()).toContain(`cwd=${realpathSync(vault)}`);
    expect(sink.text()).toContain('size=21 77');
    sessions.write('p1', '\r');
    await waitFor(() => sink.text().split(exitPrompt(3)).length === 3, 10_000);
  });

  it('stop() ends a long-running program through the helper (R6.6 path)', async () => {
    const { ctx, sessions } = await start();
    ctx.settings.profiles.shell = { command: '/bin/sh', args: `-c 'echo ready; exec sleep 30'` };
    const sink = new FakeSink();
    sessions.attach({ panelId: 'p1', profile: 'shell', phase: 'new', sink });
    await waitFor(() => sink.text().includes('ready'), 15_000);
    const pid = sessions.get('p1')!.pid!;
    expect(isAlive(pid)).toBe(true);
    await sessions.stop('p1', 'close');
    expect(sink.text()).toContain(STOPPED_PROMPT);
    await waitFor(() => !isAlive(pid), 6_000);
  });

  it('plugin unload stops every program without prompts (R7.8)', async () => {
    const { ctx, sessions } = await start();
    ctx.settings.profiles.shell = { command: '/bin/sh', args: `-c 'echo up; exec sleep 30'` };
    const a = new FakeSink();
    const b = new FakeSink();
    sessions.attach({ panelId: 'a', profile: 'shell', phase: 'new', sink: a });
    sessions.attach({ panelId: 'b', profile: 'shell', phase: 'new', sink: b });
    await waitFor(() => a.text().includes('up') && b.text().includes('up'), 15_000);
    const pids = [sessions.get('a')!.pid!, sessions.get('b')!.pid!];
    runtime!.unload();
    runtime = null;
    await waitFor(() => pids.every((p) => !isAlive(p)), 6_000);
    expect(a.text()).not.toContain(STOPPED_PROMPT);
  });
});
