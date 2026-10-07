import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridgeModule } from '../../src/bridge/index';
import { createIdeModule } from '../../src/bridge/ideModule';
import { DIFF_TOOL_HINT, claudeGlobalConfigFile, createDiffToolHint, readClaudeDiffTool } from '../../src/bridge/ideDiffHint';
import type { FeatureModule } from '../../src/core/types';
import type { SpawnContext } from '../../src/core/spawn';
import type { ShellEnvService } from '../../src/env/index';
import { createBridgeEnv, startRuntime } from '../bridge/helpers';
import { sleep } from './helpers';

const HINT = "Tip: to see Claude's edit diffs here, run /config → Diff tool → terminal (one time).";
const globalConfig = (): string => join(homedir(), '.claude.json');

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const runtimes: Runtime[] = [];

/** Stand-in for T2's shellEnv: the spawn env Claude would get. */
function fakeShellEnv(extra: Record<string, string>): FeatureModule {
  return {
    id: 'env',
    register(ctx) {
      const base = { ...(process.env as Record<string, string>) };
      delete base.CLAUDE_CONFIG_DIR;
      delete base.CLAUDE_CODE_CUSTOM_OAUTH_URL;
      ctx.services.provide('shellEnv', { getSpawnEnv: () => ({ ...base, ...extra }) } as unknown as ShellEnvService);
    },
  };
}

async function load(data: unknown = null, env: Record<string, string> = {}) {
  const rt = await startRuntime(createBridgeEnv(), [fakeShellEnv(env), createBridgeModule({ debounceMs: 10 }), createIdeModule({ seedDelaysMs: [] })], data);
  runtimes.push(rt);
  return rt;
}

function spawnCtx(profile: SpawnContext['profile'] = 'claude'): SpawnContext {
  return { profile, panelId: 'p1', vaultPath: '/vault', phase: 'new', command: profile, baseArgs: [] };
}

function writeConfig(file: string, content: unknown): void {
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

beforeEach(() => {
  rmSync(globalConfig(), { force: true });
  rmSync(join(homedir(), '.claude'), { recursive: true, force: true });
});

afterEach(() => {
  for (const rt of runtimes.splice(0)) if (!rt.ctx.unloading) rt.runtime.unload();
});

describe('Diff tool hint (R10.11, D35)', () => {
  it('the hint text is exact', () => {
    expect(DIFF_TOOL_HINT).toBe(HINT);
  });

  it('diffTool unset → hint in the first Claude panel only, persisted per vault, never again after a reload', async () => {
    writeConfig(globalConfig(), { numStartups: 3, projects: { '/vault': {} } });
    const rt = await load();
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([HINT]);
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([]);
    expect(rt.ctx.settings.moduleData.ide).toEqual({ diffHintShown: true });
    expect((rt.plugin.data as { moduleData: unknown }).moduleData).toEqual({ ide: { diffHintShown: true } });

    const saved = rt.plugin.data;
    rt.runtime.unload();
    const again = await load(saved);
    expect((await again.ctx.spawn.resolve(spawnCtx())).notices).toEqual([]);
  });

  it('diffTool "auto" → hint', async () => {
    writeConfig(globalConfig(), { diffTool: 'auto' });
    const rt = await load();
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([HINT]);
  });

  it('diffTool "terminal" → no hint and nothing recorded (checked again later)', async () => {
    writeConfig(globalConfig(), { diffTool: 'terminal' });
    const rt = await load();
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([]);
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([]);
    expect(rt.ctx.settings.moduleData.ide).toBeUndefined();
    writeConfig(globalConfig(), { diffTool: 'auto' });
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([HINT]);
  });

  it('missing or unparsable config → hint', async () => {
    let rt = await load();
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([HINT]);
    rt.runtime.unload();
    writeConfig(globalConfig(), '{"diffTool": "terminal",'); // truncated
    rt = await load();
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([HINT]);
  });

  it('respects CLAUDE_CONFIG_DIR from the spawn environment', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-config-')));
    writeConfig(globalConfig(), { diffTool: 'auto' });
    writeConfig(join(dir, '.claude.json'), { diffTool: 'terminal' });
    let rt = await load(null, { CLAUDE_CONFIG_DIR: dir });
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([]);
    rt.runtime.unload();

    writeConfig(globalConfig(), { diffTool: 'terminal' });
    writeConfig(join(dir, '.claude.json'), { diffTool: 'auto' });
    rt = await load(null, { CLAUDE_CONFIG_DIR: dir });
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([HINT]);
  });

  it('IDE connection off → no hint, nothing recorded', async () => {
    writeConfig(globalConfig(), { diffTool: 'auto' });
    const rt = await load({ ideConnectionEnabled: false });
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([]);
    expect(rt.ctx.settings.moduleData.ide).toBeUndefined();
  });

  it('non-Claude profiles → nothing (and the hint stays available for the first Claude panel)', async () => {
    writeConfig(globalConfig(), { diffTool: 'auto' });
    const rt = await load();
    for (const p of ['agy', 'shell'] as const) expect((await rt.ctx.spawn.resolve(spawnCtx(p))).notices).toEqual([]);
    expect(rt.ctx.settings.moduleData.ide).toBeUndefined();
    expect((await rt.ctx.spawn.resolve(spawnCtx())).notices).toEqual([HINT]);
  });

  it('two Claude panels starting at once → exactly one hint', async () => {
    writeConfig(globalConfig(), { diffTool: 'auto' });
    const rt = await load();
    const plans = await Promise.all([rt.ctx.spawn.resolve(spawnCtx()), rt.ctx.spawn.resolve({ ...spawnCtx(), panelId: 'p2' })]);
    expect(plans.flatMap((p) => p.notices)).toEqual([HINT]);
  });

  it("Claude's config file is byte-identical (and not re-written) after the check", async () => {
    const original = '{\n  "diffTool": "auto",\n  "projects": {"/vault": {"allowedTools": []}},\n  "oauthAccount": {"x": 1}\n}\n';
    writeConfig(globalConfig(), original);
    const before = statSync(globalConfig());
    await sleep(20);
    const rt = await load();
    await rt.ctx.spawn.resolve(spawnCtx());
    await rt.ctx.spawn.resolve(spawnCtx());
    expect(readFileSync(globalConfig(), 'utf8')).toBe(original);
    const after = statSync(globalConfig());
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode).toBe(before.mode);
  });
});

describe('claudeGlobalConfigFile (as Claude Code 2.1.292 resolves it)', () => {
  it('~/.claude.json by default; $CLAUDE_CONFIG_DIR/.claude.json when set (relative = relative to the vault)', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    expect(await claudeGlobalConfigFile({}, '/vault', home)).toBe(join(home, '.claude.json'));
    expect(await claudeGlobalConfigFile({ CLAUDE_CONFIG_DIR: '  ' }, '/vault', home)).toBe(join(home, '.claude.json'));
    expect(await claudeGlobalConfigFile({ CLAUDE_CONFIG_DIR: '/cfg' }, '/vault', home)).toBe('/cfg/.claude.json');
    expect(await claudeGlobalConfigFile({ CLAUDE_CONFIG_DIR: 'cfg' }, '/vault', home)).toBe('/vault/cfg/.claude.json');
    expect(await claudeGlobalConfigFile({ CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://x' }, '/vault', home)).toBe(join(home, '.claude-custom-oauth.json'));
  });

  it('prefers a legacy <configDir>/.config.json when it exists', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.config.json'), '{}');
    expect(await claudeGlobalConfigFile({}, '/vault', home)).toBe(join(home, '.claude', '.config.json'));
    const cfg = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')));
    writeFileSync(join(cfg, '.config.json'), '{}');
    expect(await claudeGlobalConfigFile({ CLAUDE_CONFIG_DIR: cfg }, '/vault', home)).toBe(join(cfg, '.config.json'));
  });
});

describe('readClaudeDiffTool', () => {
  const file = (content: string): string => {
    const f = join(mkdtempSync(join(tmpdir(), 'cfg-')), '.claude.json');
    writeFileSync(f, content);
    return f;
  };

  it('reads the top-level value; absent → undefined; missing / garbage / non-object / too large → null', async () => {
    expect(await readClaudeDiffTool(file('{"diffTool":"terminal"}'))).toBe('terminal');
    expect(await readClaudeDiffTool(file('{"projects":{"/x":{"diffTool":"terminal"}}}'))).toBeUndefined();
    expect(await readClaudeDiffTool(file('{"diffTool":5}'))).toBeUndefined();
    expect(await readClaudeDiffTool('/does/not/exist.json')).toBeNull();
    expect(await readClaudeDiffTool(file('not json'))).toBeNull();
    expect(await readClaudeDiffTool(file('["diffTool"]'))).toBeNull();
    expect(await readClaudeDiffTool(file(`{"diffTool":"terminal","pad":"${'x'.repeat(200)}"}`), { maxBytes: 100 })).toBeNull();
  });
});

describe('createDiffToolHint', () => {
  it('never throws: a failing config lookup gives no hint and records nothing', async () => {
    let marked = false;
    const hint = createDiffToolHint({
      isShown: () => marked,
      markShown: async () => void (marked = true),
      configFile: async () => {
        throw new Error('boom');
      },
    });
    expect(await hint()).toBeUndefined();
    expect(marked).toBe(false);
  });

  it('a failed save still shows the hint once in this load', async () => {
    let shown = false;
    const hint = createDiffToolHint({
      isShown: () => shown,
      markShown: async () => {
        shown = true;
        throw new Error('disk full');
      },
      configFile: async () => '/x',
      readDiffTool: async () => 'auto',
    });
    expect(await hint()).toBe(HINT);
    expect(await hint()).toBeUndefined();
  });
});
