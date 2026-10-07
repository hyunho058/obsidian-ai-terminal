import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpawnContributorRegistry, type SpawnContext } from '../../src/core/spawn';
import type { SpawnPhase } from '../../src/core/types';
import {
  AGY_CONTINUE_FALLBACK_MS,
  AGY_NOT_FOUND_NOTICE,
  ANOTHER_FOLDER_NOTICE,
  createResumeContributor,
  isSessionUuid,
  type ResumeDeps,
} from '../../src/session/resume';
import type { TranscriptLookup } from '../../src/session/resumeTranscript';
import { createLogger } from '../../src/util/log';
import { claudeHome, conversation, metaLines, resetClaudeHome, tempDir, writeTranscript } from './fixtures';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const quiet = createLogger(undefined, { debug() {}, info() {}, warn() {}, error() {} });

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
beforeAll(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterAll(() => {
  if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

let vault: string;
beforeEach(() => {
  resetClaudeHome();
  vault = tempDir('vault-');
});

function ctx(over: Partial<SpawnContext> = {}): SpawnContext {
  return { profile: 'claude', panelId: 'p1', vaultPath: vault, phase: 'new', command: 'claude', baseArgs: ['--model', 'sonnet'], ...over };
}

function contributor(deps: Partial<ResumeDeps> = {}) {
  return createResumeContributor({ log: quiet, configDir: () => claudeHome(), ...deps });
}

function stubLookup(status: TranscriptLookup['status'], extra: Partial<TranscriptLookup> = {}) {
  return vi.fn(async (): Promise<TranscriptLookup> => ({ status, files: [], errors: [], ...extra }));
}

describe('Claude — new panel (R5.3)', () => {
  it('generates a UUID, starts --session-id <uuid> after the user args and stores it', async () => {
    const out = await contributor()(ctx());
    expect(out).toBeTruthy();
    const id = out!.sessionId!;
    expect(id).toMatch(UUID);
    expect(out).toEqual({ replaceArgs: ['--model', 'sonnet', '--session-id', id], sessionId: id });
  });

  it('every new panel gets its own id, even when a stale id is passed in', async () => {
    const c = contributor();
    const a = await c(ctx());
    const b = await c(ctx({ panelId: 'p2', sessionId: randomUUID() }));
    expect(a!.sessionId).not.toBe(b!.sessionId);
  });

  it('uses the injected id generator', async () => {
    const out = await contributor({ newId: () => 'fixed-id' })(ctx());
    expect(out).toEqual({ replaceArgs: ['--model', 'sonnet', '--session-id', 'fixed-id'], sessionId: 'fixed-id' });
  });
});

describe.each<SpawnPhase>(['restore', 'restart'])('Claude — %s', (phase) => {
  it('transcript recorded in the vault → --resume <same uuid>, id unchanged, no notice (R5.4)', async () => {
    const id = randomUUID();
    conversation(id, vault);
    expect(await contributor()(ctx({ phase, sessionId: id }))).toEqual({ replaceArgs: ['--model', 'sonnet', '--resume', id] });
  });

  it('conversation that moved into a subfolder still resumes (R5.5)', async () => {
    const id = randomUUID();
    conversation(id, vault, [`${vault}/Projects`]);
    expect(await contributor()(ctx({ phase, sessionId: id }))).toEqual({ replaceArgs: ['--model', 'sonnet', '--resume', id] });
  });

  it('no transcript → --session-id <same uuid>, no notice, id unchanged (R5.6, R5.12)', async () => {
    const id = randomUUID();
    expect(await contributor()(ctx({ phase, sessionId: id }))).toEqual({ replaceArgs: ['--model', 'sonnet', '--session-id', id] });
  });

  it('transcript from another folder → new uuid, notice, stored (R5.7)', async () => {
    const id = randomUUID();
    conversation(id, tempDir('other-'));
    const out = await contributor()(ctx({ phase, sessionId: id }));
    const next = out!.sessionId!;
    expect(next).toMatch(UUID);
    expect(next).not.toBe(id);
    expect(out).toEqual({ replaceArgs: ['--model', 'sonnet', '--session-id', next], sessionId: next, notice: ANOTHER_FOLDER_NOTICE });
  });

  it('no stored id (old layout) → behaves like a new panel', async () => {
    const out = await contributor()(ctx({ phase }));
    expect(out!.sessionId).toMatch(UUID);
    expect(out!.replaceArgs).toEqual(['--model', 'sonnet', '--session-id', out!.sessionId]);
    expect(out!.notice).toBeUndefined();
  });

  it('a stored id that is not a UUID is never used as a file name → new panel', async () => {
    const lookup = vi.fn();
    const out = await contributor({ lookup })(ctx({ phase, sessionId: '../../../etc/passwd' }));
    expect(lookup).not.toHaveBeenCalled();
    expect(out!.sessionId).toMatch(UUID);
    expect(out!.replaceArgs).toEqual(['--model', 'sonnet', '--session-id', out!.sessionId]);
  });

  it('transcript without any recorded cwd (no messages) → silent new id (Claude rejects --session-id for an existing file)', async () => {
    const id = randomUUID();
    writeTranscript(id, metaLines(id));
    const out = await contributor()(ctx({ phase, sessionId: id }));
    expect(out!.sessionId).toMatch(UUID);
    expect(out!.sessionId).not.toBe(id);
    expect(out!.notice).toBeUndefined();
    expect(out!.replaceArgs).toEqual(['--model', 'sonnet', '--session-id', out!.sessionId]);
  });

  it('unreadable transcript → keeps the same uuid (--session-id), no notice', async () => {
    const id = randomUUID();
    const out = await contributor({ lookup: stubLookup('unreadable', { errors: ['EACCES'] }) })(ctx({ phase, sessionId: id }));
    expect(out).toEqual({ replaceArgs: ['--model', 'sonnet', '--session-id', id] });
  });
});

describe('Claude — defensive', () => {
  it('a failing lookup never throws and keeps the stored id', async () => {
    const id = randomUUID();
    const lookup = vi.fn(async () => {
      throw new Error('EIO');
    });
    expect(await contributor({ lookup })(ctx({ phase: 'restore', sessionId: id }))).toEqual({ replaceArgs: ['--model', 'sonnet', '--session-id', id] });
  });

  it('a failing configDir() never throws and keeps the stored id', async () => {
    const id = randomUUID();
    const out = await contributor({
      configDir: () => {
        throw new Error('boom');
      },
    })(ctx({ phase: 'restart', sessionId: id }));
    expect(out).toEqual({ replaceArgs: ['--model', 'sonnet', '--session-id', id] });
  });

  it('a hanging lookup is cut off after lookupTimeoutMs and keeps the stored id', async () => {
    const id = randomUUID();
    const lookup = vi.fn(() => new Promise<TranscriptLookup>(() => {}));
    const started = Date.now();
    const out = await contributor({ lookup, lookupTimeoutMs: 30 })(ctx({ phase: 'restore', sessionId: id }));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).toEqual({ replaceArgs: ['--model', 'sonnet', '--session-id', id] });
  });

  it('a failing id generator does not throw (plain command)', async () => {
    const out = await contributor({
      newId: () => {
        throw new Error('no entropy');
      },
    })(ctx());
    expect(out).toBeUndefined();
  });

  it('logs lookup problems at debug level only', async () => {
    const lines: Array<[string, string]> = [];
    const log = createLogger(undefined, {
      debug: (...a: unknown[]) => lines.push(['debug', a.join(' ')]),
      info: (...a: unknown[]) => lines.push(['info', a.join(' ')]),
      warn: (...a: unknown[]) => lines.push(['warn', a.join(' ')]),
      error: (...a: unknown[]) => lines.push(['error', a.join(' ')]),
    });
    const { setDebugLogging } = await import('../../src/util/log');
    setDebugLogging(true);
    try {
      await contributor({ log, lookup: stubLookup('unreadable', { errors: ['x: EACCES'] }) })(ctx({ phase: 'restore', sessionId: randomUUID() }));
    } finally {
      setDebugLogging(false);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every(([level]) => level === 'debug')).toBe(true);
  });

  it('leaves the conversation alone when the profile arguments already pick one', async () => {
    const c = contributor();
    for (const baseArgs of [['--continue'], ['-c'], ['--resume'], ['-r', 'x'], ['--resume=abc'], ['--session-id', randomUUID()]]) {
      expect(await c(ctx({ baseArgs }))).toBeUndefined();
      expect(await c(ctx({ baseArgs, phase: 'restore', sessionId: randomUUID() }))).toBeUndefined();
    }
  });
});

describe('Two Claude panels each resume their own chat (R5.8)', () => {
  it('panel A resumes a, panel B resumes b — a pure function of each view state', async () => {
    const a = randomUUID();
    const b = randomUUID();
    conversation(a, vault);
    conversation(b, vault);
    const c = contributor();
    const [outA, outB] = await Promise.all([
      c(ctx({ panelId: 'A', phase: 'restore', sessionId: a })),
      c(ctx({ panelId: 'B', phase: 'restore', sessionId: b })),
    ]);
    expect(outA).toEqual({ replaceArgs: ['--model', 'sonnet', '--resume', a] });
    expect(outB).toEqual({ replaceArgs: ['--model', 'sonnet', '--resume', b] });
    // Same answer again (no hidden state).
    expect(await c(ctx({ panelId: 'A', phase: 'restore', sessionId: a }))).toEqual(outA);
  });
});

describe('Antigravity (R5.10)', () => {
  const agy = (over: Partial<SpawnContext> = {}) => ctx({ profile: 'agy', command: 'agy', baseArgs: ['--model', 'x'], ...over });

  it('new panel → nothing', async () => {
    expect(await contributor()(agy())).toBeUndefined();
  });

  it.each<SpawnPhase>(['restore', 'restart'])('%s → --continue with a 5 s fallback to plain agy', async (phase) => {
    expect(await contributor()(agy({ phase }))).toEqual({
      replaceArgs: ['--model', 'x', '--continue'],
      fallback: { withinMs: 5_000, replaceArgs: ['--model', 'x'], notice: '[Previous conversation not found — starting a new one]' },
    });
    expect(AGY_CONTINUE_FALLBACK_MS).toBe(5_000);
    expect(AGY_NOT_FOUND_NOTICE).toBe('[Previous conversation not found — starting a new one]');
  });

  it('ignores the stored session id and never touches Claude transcripts', async () => {
    const lookup = vi.fn();
    const out = await contributor({ lookup })(agy({ phase: 'restore', sessionId: randomUUID() }));
    expect(lookup).not.toHaveBeenCalled();
    expect(out!.sessionId).toBeUndefined();
  });

  it('leaves user-chosen --conversation / --continue alone', async () => {
    expect(await contributor()(agy({ phase: 'restore', baseArgs: ['--conversation', 'abc'] }))).toBeUndefined();
    expect(await contributor()(agy({ phase: 'restore', baseArgs: ['-c'] }))).toBeUndefined();
  });

  it('resolves through the registry: fallback args = base args + other contributors', async () => {
    const reg = new SpawnContributorRegistry();
    reg.add('resume', contributor());
    reg.add('bridge', () => ({ args: ['--bridge'] }));
    const plan = await reg.resolve(agy({ phase: 'restore' }));
    expect(plan.args).toEqual(['--model', 'x', '--continue', '--bridge']);
    expect(plan.fallback).toEqual({ withinMs: 5_000, args: ['--model', 'x', '--bridge'], notice: AGY_NOT_FOUND_NOTICE });
    expect(plan.notices).toEqual([]);
  });
});

describe('Shell', () => {
  it.each<SpawnPhase>(['new', 'restore', 'restart'])('%s → nothing (R5.11 is the launcher’s)', async (phase) => {
    expect(await contributor()(ctx({ profile: 'shell', command: '/bin/zsh', baseArgs: ['-l'], phase, sessionId: randomUUID() }))).toBeUndefined();
  });
});

describe('Through SpawnContributorRegistry', () => {
  it('Claude restore with a foreign transcript: plan carries the new id and the notice, other args still appended', async () => {
    const id = randomUUID();
    conversation(id, '/not/the/vault');
    const reg = new SpawnContributorRegistry();
    reg.add('resume', contributor());
    reg.add('mcp', () => ({ args: ['--mcp-config', '{}'] }));
    const plan = await reg.resolve(ctx({ phase: 'restore', sessionId: id }));
    expect(plan.sessionId).toMatch(UUID);
    expect(plan.sessionId).not.toBe(id);
    expect(plan.args).toEqual(['--model', 'sonnet', '--session-id', plan.sessionId, '--mcp-config', '{}']);
    expect(plan.notices).toEqual([ANOTHER_FOLDER_NOTICE]);
  });

  it('Claude restore without a transcript keeps the incoming id in the plan', async () => {
    const id = randomUUID();
    const reg = new SpawnContributorRegistry();
    reg.add('resume', contributor());
    const plan = await reg.resolve(ctx({ phase: 'restore', sessionId: id }));
    expect(plan.sessionId).toBe(id);
    expect(plan.args).toEqual(['--model', 'sonnet', '--session-id', id]);
    expect(plan.notices).toEqual([]);
  });
});

describe('isSessionUuid', () => {
  it('accepts UUIDs only', () => {
    expect(isSessionUuid(randomUUID())).toBe(true);
    expect(isSessionUuid(randomUUID().toUpperCase())).toBe(true);
    for (const bad of ['', 'abc', '../x', `${randomUUID()}/..`, 42, undefined, null]) expect(isSessionUuid(bad)).toBe(false);
  });
});
