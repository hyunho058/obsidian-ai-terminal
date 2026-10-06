// Opt-in: AI_TERMINAL_SMOKE=1 npx vitest run tests/session/smoke.test.ts
// Opens real `claude` / `agy` panels through the session registry (temp vault, temp HOME from tests/setup.ts),
// moves the panel (detach + reattach) and stops it — each within ~8 s. Never touches the user's real config.
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { App, Plugin } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { PluginRuntime } from '../../src/core/runtime';
import { createEnvModule } from '../../src/env/index';
import { createPtyModule } from '../../src/pty/index';
import { createSessionModule } from '../../src/session/index';
import { SettingsStore } from '../../src/settings';
import { createLogger } from '../../src/util/log';
import { createManifest, createMockApp, Plugin as MockPlugin } from '../mocks/obsidian';
import { HELPER_SOURCE, isAlive } from '../pty/helpers';
import { FakeSink, waitFor } from './helpers';

const SMOKE = process.env.AI_TERMINAL_SMOKE === '1';

class TestPlugin extends MockPlugin {}

describe.skipIf(!SMOKE)('smoke: real CLI panels through the session registry', () => {
  for (const profile of ['claude', 'agy'] as const) {
    it(`${profile}: startup screen, move without restart, stop`, async () => {
      const bin = join(userInfo().homedir, '.local', 'bin', profile);
      if (!existsSync(bin)) {
        console.warn(`smoke: ${bin} not installed — skipped`);
        return;
      }
      const pluginDir = mkdtempSync(join(tmpdir(), 'plugindir-'));
      copyFileSync(HELPER_SOURCE, join(pluginDir, 'pty_bridge.py'));
      const vault = mkdtempSync(join(tmpdir(), `smoke-vault-${profile}-`));
      const app = createMockApp(vault);
      const plugin = new TestPlugin(app, createManifest());
      const store = new SettingsStore((d) => plugin.saveData(d));
      store.load(null);
      store.settings.profiles[profile].command = bin;
      const runtime = new PluginRuntime({
        app: app as unknown as App,
        plugin: plugin as unknown as Plugin,
        settingsStore: store,
        vaultPath: vault,
        pluginDir,
        log: createLogger(undefined, { debug() {}, info() {}, warn() {}, error() {} }),
      });
      await runtime.start([createEnvModule(), createPtyModule(), createSessionModule()]);
      const sessions = runtime.ctx.services.require('sessions');
      try {
        const t0 = Date.now();
        const sink = new FakeSink();
        sessions.attach({ panelId: 'smoke', profile, phase: 'new', sink });
        await waitFor(() => /\x1b\[/.test(sink.text()) && sink.text().length > 500, 6_000);
        const pid = sessions.get('smoke')!.pid!;
        sessions.detach('smoke', sink);
        const moved = new FakeSink('moved');
        moved.size = { cols: 110, rows: 35 };
        sessions.attach({ panelId: 'smoke', profile, phase: 'restore', sink: moved });
        await waitFor(() => moved.restores.length === 1, 2_000);
        const data = moved.restores[0]!.data;
        expect(data.length).toBeGreaterThan(100);
        const modes = ['?1049h', '?2004h', '?1h', '?1000h', '?1002h', '?1003h', '?1006h', '?25l', '?1004h'].filter((m) => data.includes(`\x1b[${m}`));
        console.info(`smoke ${profile}: modes restored after the move: ${modes.join(' ') || '(none)'}`);
        expect(sessions.get('smoke')!.pid).toBe(pid);
        expect(Date.now() - t0).toBeLessThan(8_000);
        await sessions.stop('smoke', 'smoke done');
        await waitFor(() => !isAlive(pid), 6_000);
      } finally {
        runtime.unload();
      }
    }, 20_000);
  }
});
