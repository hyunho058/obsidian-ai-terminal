// Snapshot test helpers: temp vaults, git wrappers (slow / failing / counting) around the real /usr/bin/git, and a
// plugin runtime with the bridge + snapshot modules over a temp vault. Everything lives under the per-file temp HOME.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { App, Plugin } from 'obsidian';
import { PluginRuntime } from '../../src/core/runtime';
import type { FeatureModule, TerminalPanelHandle } from '../../src/core/types';
import type { ProfileId } from '../../src/core/constants';
import { SettingsStore } from '../../src/settings';
import { GitRunner } from '../../src/snapshot/git';
import { SnapshotStore } from '../../src/snapshot/store';
import { createLogger, type LogSink, type Logger } from '../../src/util/log';
import { App as MockApp, Plugin as MockPlugin, createManifest } from '../mocks/obsidian';

export const REAL_GIT = '/usr/bin/git';

export function silentSink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]): void => void lines.push(a.join(' '));
  return { lines, debug: push, info: push, warn: push, error: push };
}

export function testLogger(): Logger & { sink: ReturnType<typeof silentSink> } {
  const sink = silentSink();
  return Object.assign(createLogger('t', sink), { sink });
}

export function tempDir(prefix = 'snap-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A temp vault with the given files (`path → content`). */
export function makeVault(files: Record<string, string> = {}): string {
  const vault = tempDir('vault-');
  for (const [p, content] of Object.entries(files)) writeFile(vault, p, content);
  return vault;
}

export function writeFile(vault: string, rel: string, content: string): void {
  const full = join(vault, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function readFile(vault: string, rel: string): string {
  return readFileSync(join(vault, rel), 'utf8');
}

export interface WrapperOptions {
  /** Sleep this long before running these subcommands (`*` = every command). */
  sleepOn?: { commands: string[]; seconds: number };
  /** Fail these subcommands with `fatal: <message>`. */
  failOn?: { commands: string[]; message: string };
  /** Append each subcommand to this file. */
  logTo?: string;
}

/** A bash wrapper around /usr/bin/git (first non-option argument = subcommand). */
export function gitWrapper(opts: WrapperOptions): string {
  const dir = tempDir('gitwrap-');
  const file = join(dir, 'git');
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const lines = [
    '#!/bin/bash',
    'sub=""; skip=0',
    'for a in "$@"; do',
    '  if [ $skip = 1 ]; then skip=0; continue; fi',
    '  case "$a" in -c) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac',
    'done',
  ];
  if (opts.logTo) lines.push(`echo "$sub" >> ${q(opts.logTo)}`);
  if (opts.sleepOn) {
    const cmds = opts.sleepOn.commands.join('|');
    lines.push(`case "$sub" in ${cmds === '*' ? '*' : cmds}) sleep ${opts.sleepOn.seconds} ;; esac`);
  }
  if (opts.failOn) {
    lines.push(`case "$sub" in ${opts.failOn.commands.join('|')}) echo ${q(`fatal: ${opts.failOn.message}`)} >&2; exit 128 ;; esac`);
  }
  lines.push(`exec ${REAL_GIT} "$@"`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  chmodSync(file, 0o755);
  return file;
}

export function newStore(vault: string, gitPath = REAL_GIT, log?: Logger): SnapshotStore {
  return new SnapshotStore({ vaultPath: vault, git: new GitRunner(gitPath), log, configDir: '.obsidian' });
}

/** Plain git (real binary, isolated config) against a store, for assertions. */
export function storeGit(store: string, vault: string, args: string[]): string {
  return execFileSync(REAL_GIT, [`--git-dir=${store}`, `--work-tree=${vault}`, ...args], {
    cwd: vault,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

export function commitCount(store: string, vault: string): number {
  try {
    return Number(storeGit(store, vault, ['rev-list', '--count', 'HEAD']).trim());
  } catch {
    return 0;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ fake panels / runtime

export interface FakePanel extends TerminalPanelHandle {
  printed: string[];
  sent: string[];
}

export function fakePanel(profile: ProfileId, panelId = `${profile}-panel`): FakePanel {
  const printed: string[] = [];
  const sent: string[] = [];
  return {
    panelId,
    profile,
    sessionId: undefined,
    state: 'running',
    terminal: undefined,
    printed,
    sent,
    sendInput: (d) => void sent.push(d),
    print: (t) => void printed.push(t),
    holdInput: () => () => {},
  };
}

export interface RuntimeOptions {
  vault: string;
  modules: FeatureModule[];
  data?: unknown;
  panels?: FakePanel[];
  python?: string;
  /** Plugin folder (default: a new empty temp dir). */
  pluginDir?: string;
}

/** PluginRuntime over a mock app for `vault`, with fake `sessions` and `python` services. */
export async function startRuntime(o: RuntimeOptions) {
  const app = new MockApp(o.vault);
  const plugin = new (class extends MockPlugin {})(app, createManifest());
  plugin.load();
  const store = new SettingsStore((d) => plugin.saveData(d));
  store.load(o.data ?? null);
  const sink = silentSink();
  const pluginDir = o.pluginDir ?? tempDir('plugindir-');
  const runtime = new PluginRuntime({
    app: app as unknown as App,
    plugin: plugin as unknown as Plugin,
    settingsStore: store,
    vaultPath: o.vault,
    pluginDir,
    log: createLogger(undefined, sink),
  });
  const panels = new Map((o.panels ?? []).map((p) => [p.panelId, p]));
  const fakeServices: FeatureModule = {
    id: 'fakes',
    register(ctx) {
      ctx.services.provide('sessions', { get: (id: string) => panels.get(id), list: () => [...panels.values()] } as never);
      ctx.services.provide('python', {
        resolve: async () => o.python ?? '/usr/bin/python3',
        current: () => o.python ?? '/usr/bin/python3',
        invalidate: () => {},
      } as never);
    },
  };
  await runtime.start([fakeServices, ...o.modules]);
  await runtime.ctx.ready;
  return { runtime, ctx: runtime.ctx, app, plugin, store, sink, pluginDir, panels };
}
