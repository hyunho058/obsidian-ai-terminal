// The resume module wired into the real SessionRegistry (fake PTY): what the launcher spawns and what the view stores.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exitPrompt } from '../../src/session/SessionRegistry';
import { AGY_NOT_FOUND_NOTICE, ANOTHER_FOLDER_NOTICE } from '../../src/session/resume';
import { createResumeModule } from '../../src/session/resumeModule';
import { FakeSink, makeHarness, waitFor, type Harness } from '../session/helpers';
import { conversation, resetClaudeHome, tempDir } from './fixtures';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FAST = { graceMs: 120, duplicateWindowMs: 60, nudgeDelayMs: 5 };

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
beforeAll(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterAll(() => {
  if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});
beforeEach(() => resetClaudeHome());

let current: Harness | null = null;
afterEach(() => {
  current?.registry?.dispose();
  current?.runtime.unload();
  current = null;
});

async function harness(): Promise<Harness> {
  current = await makeHarness({ registry: FAST, extraModules: [createResumeModule()] });
  return current;
}

async function open(h: Harness, panelId: string, profile: 'claude' | 'agy' | 'shell', phase: 'new' | 'restore', sessionId?: string) {
  const sink = new FakeSink(panelId);
  const before = h.pty.spawned.length;
  h.registry.attach({ panelId, profile, phase, sink, ...(sessionId ? { sessionId } : {}) });
  await waitFor(() => h.pty.spawned.length > before && h.registry.get(panelId)?.state === 'running');
  return { sink, proc: h.pty.last, session: h.registry.get(panelId)! };
}

describe('resume module + session registry', () => {
  it('registers the "resume" contributor', async () => {
    const h = await harness();
    expect(h.ctx.spawn.names()).toContain('resume');
  });

  it('new Claude panel: command has --session-id <uuid> and the view state stores it (R5.3)', async () => {
    const h = await harness();
    const { sink, proc, session } = await open(h, 'p1', 'claude', 'new');
    const id = session.sessionId!;
    expect(id).toMatch(UUID);
    expect(proc.command).toBe('claude');
    expect(proc.args).toEqual(['--session-id', id]);
    expect(sink.identities).toEqual([{ panelId: 'p1', sessionId: id }]);
  });

  it('restored Claude panel with a vault transcript: --resume <uuid> (R5.4)', async () => {
    const h = await harness();
    const id = randomUUID();
    conversation(id, h.ctx.vaultPath, [`${h.ctx.vaultPath}/Projects`]);
    const { sink, proc, session } = await open(h, 'p1', 'claude', 'restore', id);
    expect(proc.args).toEqual(['--resume', id]);
    expect(session.sessionId).toBe(id);
    expect(sink.identities).toEqual([]);
  });

  it('early failure after --resume keeps the session id; Enter resumes the same id again (R5.12, R5.2)', async () => {
    const h = await harness();
    const id = randomUUID();
    conversation(id, h.ctx.vaultPath);
    const { sink, proc } = await open(h, 'p1', 'claude', 'restore', id);
    proc.emitData('Error: authentication failed\r\n');
    proc.exit(1);
    await waitFor(() => sink.text().includes(exitPrompt(1)));
    expect(h.registry.get('p1')!.sessionId).toBe(id);
    expect(sink.identities).toEqual([]);
    h.registry.write('p1', '\r');
    await waitFor(() => h.pty.spawned.length === 2 && h.registry.get('p1')!.state === 'running');
    expect(h.pty.last.args).toEqual(['--resume', id]);
    expect(h.registry.get('p1')!.sessionId).toBe(id);
  });

  it('restart after a failure before any transcript was written: --session-id <same uuid>', async () => {
    const h = await harness();
    const { sink, proc, session } = await open(h, 'p1', 'claude', 'new');
    const id = session.sessionId!;
    proc.exit(1); // e.g. network error at startup — no transcript yet
    await waitFor(() => sink.text().includes(exitPrompt(1)));
    expect(h.registry.get('p1')!.sessionId).toBe(id);
    h.registry.write('p1', '\r');
    await waitFor(() => h.pty.spawned.length === 2 && h.registry.get('p1')!.state === 'running');
    expect(h.pty.last.args).toEqual(['--session-id', id]);
    expect(h.registry.get('p1')!.sessionId).toBe(id);
    expect(sink.text()).not.toContain(ANOTHER_FOLDER_NOTICE);
  });

  it('missing transcript on restore: --session-id <same uuid>, no error line (R5.6)', async () => {
    const h = await harness();
    const id = randomUUID();
    const { sink, proc } = await open(h, 'p1', 'claude', 'restore', id);
    expect(proc.args).toEqual(['--session-id', id]);
    expect(sink.text()).not.toMatch(/\[Previous conversation/);
    expect(sink.identities).toEqual([]);
  });

  it('transcript from another folder: notice printed, new uuid spawned and stored (R5.7)', async () => {
    const h = await harness();
    const id = randomUUID();
    conversation(id, tempDir('elsewhere-'));
    const { sink, proc, session } = await open(h, 'p1', 'claude', 'restore', id);
    const next = session.sessionId!;
    expect(next).toMatch(UUID);
    expect(next).not.toBe(id);
    expect(proc.args).toEqual(['--session-id', next]);
    expect(sink.text()).toContain(`${ANOTHER_FOLDER_NOTICE}\r\n`);
    expect(sink.identities).toEqual([{ panelId: 'p1', sessionId: next }]);
  });

  it('two Claude panels each resume their own chat (R5.8)', async () => {
    const h = await harness();
    const a = randomUUID();
    const b = randomUUID();
    conversation(a, h.ctx.vaultPath);
    conversation(b, h.ctx.vaultPath);
    const A = await open(h, 'A', 'claude', 'restore', a);
    const B = await open(h, 'B', 'claude', 'restore', b);
    expect(A.proc.args).toEqual(['--resume', a]);
    expect(B.proc.args).toEqual(['--resume', b]);
  });

  it('user arguments stay in front of the resume flags', async () => {
    const h = await harness();
    h.ctx.settings.profiles.claude = { command: 'claude', args: '--model sonnet' };
    const id = randomUUID();
    conversation(id, h.ctx.vaultPath);
    const { proc } = await open(h, 'p1', 'claude', 'restore', id);
    expect(proc.args).toEqual(['--model', 'sonnet', '--resume', id]);
  });

  it('restored Antigravity panel: --continue, and plain agy with a notice if it fails within 5 s (R5.10)', async () => {
    const h = await harness();
    const { sink, proc } = await open(h, 'g1', 'agy', 'restore');
    expect(proc.command).toBe('agy');
    expect(proc.args).toEqual(['--continue']);
    proc.exit(1);
    await waitFor(() => h.pty.spawned.length === 2 && h.registry.get('g1')!.state === 'running');
    expect(h.pty.last.args).toEqual([]);
    expect(sink.text()).toContain(`${AGY_NOT_FOUND_NOTICE}\r\n`);
  });

  it('new Antigravity panel and shells start plain; a restored shell starts fresh in the vault folder', async () => {
    const h = await harness();
    expect((await open(h, 'g1', 'agy', 'new')).proc.args).toEqual([]);
    const shell = await open(h, 's1', 'shell', 'restore');
    expect(shell.proc.args).toEqual(['-l']);
    expect(shell.proc.opts.cwd).toBe(h.ctx.vaultPath);
    expect(shell.session.sessionId).toBeUndefined();
  });
});
