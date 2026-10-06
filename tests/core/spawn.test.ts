import { describe, expect, it, vi } from 'vitest';
import { SpawnContributorRegistry, type SpawnContext } from '../../src/core/spawn';

const base = (over: Partial<SpawnContext> = {}): SpawnContext => ({
  profile: 'claude',
  panelId: 'p1',
  vaultPath: '/vault',
  phase: 'new',
  command: 'claude',
  baseArgs: ['--model', 'sonnet'],
  ...over,
});

describe('SpawnContributorRegistry.resolve', () => {
  it('returns the base command and args when nothing contributes', async () => {
    const plan = await new SpawnContributorRegistry().resolve(base());
    expect(plan).toEqual({ command: 'claude', args: ['--model', 'sonnet'], env: {}, notices: [] });
  });

  it('appends args in registration order and merges env with later contributors winning', async () => {
    const reg = new SpawnContributorRegistry();
    reg.add('a', () => ({ args: ['--mcp-config', '{}'], env: { A: '1', SHARED: 'a' } }));
    reg.add('b', async () => ({ args: ['--ide'], env: { B: '2', SHARED: 'b' } }));
    const plan = await reg.resolve(base());
    expect(plan.args).toEqual(['--model', 'sonnet', '--mcp-config', '{}', '--ide']);
    expect(plan.env).toEqual({ A: '1', B: '2', SHARED: 'b' });
  });

  it('replaceArgs replaces only the base args, wherever the contributor sits', async () => {
    const reg = new SpawnContributorRegistry();
    reg.add('bridge', () => ({ args: ['--mcp-config', 'X'] }));
    reg.add('resume', (ctx) => ({ replaceArgs: [...ctx.baseArgs, '--resume', 'u1'] }));
    const plan = await reg.resolve(base());
    expect(plan.args).toEqual(['--model', 'sonnet', '--resume', 'u1', '--mcp-config', 'X']);
  });

  it('last replaceArgs wins and the override is reported', async () => {
    const report = vi.fn();
    const reg = new SpawnContributorRegistry(report);
    reg.add('one', () => ({ replaceArgs: ['--one'] }));
    reg.add('two', () => ({ replaceArgs: ['--two'] }));
    const plan = await reg.resolve(base());
    expect(plan.args).toEqual(['--two']);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('overrides replaceArgs'));
  });

  it('collects notices, sessionId and a resolved fallback', async () => {
    const reg = new SpawnContributorRegistry();
    reg.add('resume', () => ({
      notice: '[Previous conversation belongs to another folder — starting a new one]',
      sessionId: 'new-uuid',
      replaceArgs: ['--continue'],
      fallback: { withinMs: 5000, replaceArgs: [], notice: '[Previous conversation not found — starting a new one]' },
    }));
    reg.add('env', () => ({ args: ['--x'], env: { OBSIDIAN_BRIDGE_URL: 'u' } }));
    const plan = await reg.resolve(base({ profile: 'agy', command: 'agy', baseArgs: [], sessionId: 'old' }));
    expect(plan.notices).toEqual(['[Previous conversation belongs to another folder — starting a new one]']);
    expect(plan.sessionId).toBe('new-uuid');
    expect(plan.args).toEqual(['--continue', '--x']);
    expect(plan.fallback).toEqual({ withinMs: 5000, args: ['--x'], notice: '[Previous conversation not found — starting a new one]' });
  });

  it('keeps the incoming sessionId when no contributor changes it', async () => {
    const plan = await new SpawnContributorRegistry().resolve(base({ sessionId: 's1' }));
    expect(plan.sessionId).toBe('s1');
  });

  it('skips a throwing contributor and reports it', async () => {
    const report = vi.fn();
    const reg = new SpawnContributorRegistry(report);
    reg.add('bad', () => {
      throw new Error('boom');
    });
    reg.add('good', () => ({ args: ['--ok'] }));
    const plan = await reg.resolve(base({ baseArgs: [] }));
    expect(plan.args).toEqual(['--ok']);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('"bad" failed'), expect.any(Error));
  });

  it('passes frozen baseArgs and the full context; void means no contribution', async () => {
    const reg = new SpawnContributorRegistry();
    const seen: SpawnContext[] = [];
    reg.add('spy', (ctx) => {
      seen.push(ctx);
      expect(() => (ctx.baseArgs as string[]).push('x')).toThrow();
    });
    const plan = await reg.resolve(base({ phase: 'restore' }));
    expect(seen[0]).toMatchObject({ profile: 'claude', panelId: 'p1', phase: 'restore', vaultPath: '/vault' });
    expect(plan.args).toEqual(['--model', 'sonnet']);
  });

  it('disposer unregisters a contributor', async () => {
    const reg = new SpawnContributorRegistry();
    const off = reg.add('a', () => ({ args: ['--a'] }));
    expect(reg.names()).toEqual(['a']);
    off();
    expect((await reg.resolve(base({ baseArgs: [] }))).args).toEqual([]);
  });
});
