import { describe, expect, it } from 'vitest';
import { IDE_FLAG, SSE_PORT_ENV, createClaudeIdeContributor, type IdeEndpoint } from '../../src/bridge/claudeIdeContributor';
import type { SpawnContext } from '../../src/core/spawn';

function ctx(profile: SpawnContext['profile'], baseArgs: string[] = ['--model', 'sonnet']): SpawnContext {
  return { profile, panelId: 'p', vaultPath: '/vault', phase: 'new', command: profile, baseArgs };
}

function endpoint(state: 'running' | 'starting' | 'stopped', port = 4567): IdeEndpoint & { resolveStart(): void } {
  let resolveStart!: () => void;
  const started = new Promise<void>((r) => (resolveStart = r));
  let running = state === 'running';
  return {
    get port() {
      return running ? port : null;
    },
    isRunning: () => running,
    whenListening: () => (running ? Promise.resolve() : state === 'starting' ? started.then(() => void (running = true)) : Promise.reject(new Error('off'))),
    resolveStart: () => resolveStart(),
  };
}

describe('claude IDE contributor (R10.3, R11.1)', () => {
  it('adds --ide and CLAUDE_CODE_SSE_PORT=<port> for Claude panels', async () => {
    const contribute = createClaudeIdeContributor(() => endpoint('running'));
    expect(await contribute(ctx('claude'))).toEqual({ args: ['--ide'], env: { CLAUDE_CODE_SSE_PORT: '4567' } });
    expect(IDE_FLAG).toBe('--ide');
    expect(SSE_PORT_ENV).toBe('CLAUDE_CODE_SSE_PORT');
  });

  it('does not repeat --ide when the profile args already have it', async () => {
    const contribute = createClaudeIdeContributor(() => endpoint('running'));
    expect(await contribute(ctx('claude', ['--ide']))).toEqual({ args: [], env: { CLAUDE_CODE_SSE_PORT: '4567' } });
  });

  it('contributes nothing for agy / shell panels', async () => {
    const contribute = createClaudeIdeContributor(() => endpoint('running'));
    expect(await contribute(ctx('agy'))).toBeUndefined();
    expect(await contribute(ctx('shell'))).toBeUndefined();
  });

  it('contributes nothing while the IDE connection is off (R10.10) or not listening', async () => {
    expect(await createClaudeIdeContributor(() => undefined)(ctx('claude'))).toBeUndefined();
    expect(await createClaudeIdeContributor(() => endpoint('stopped'))(ctx('claude'))).toBeUndefined();
  });

  it('waits for a server that is still starting', async () => {
    const ep = endpoint('starting');
    const pending = createClaudeIdeContributor(() => ep)(ctx('claude'));
    ep.resolveStart();
    expect(await pending).toEqual({ args: ['--ide'], env: { CLAUDE_CODE_SSE_PORT: '4567' } });
  });

  it('adds the one-time hint as a notice, and never asks for it when contributing nothing', async () => {
    let asked = 0;
    const hint = async () => (asked++, 'Tip: x');
    expect(await createClaudeIdeContributor(() => endpoint('running'), { hint })(ctx('claude'))).toEqual({
      args: ['--ide'],
      env: { CLAUDE_CODE_SSE_PORT: '4567' },
      notice: 'Tip: x',
    });
    expect(asked).toBe(1);
    await createClaudeIdeContributor(() => undefined, { hint })(ctx('claude'));
    await createClaudeIdeContributor(() => endpoint('stopped'), { hint })(ctx('claude'));
    await createClaudeIdeContributor(() => endpoint('running'), { hint })(ctx('agy'));
    expect(asked).toBe(1);
  });

  it('a failing hint never blocks the spawn', async () => {
    const hint = async (): Promise<string | undefined> => {
      throw new Error('boom');
    };
    expect(await createClaudeIdeContributor(() => endpoint('running'), { hint })(ctx('claude'))).toEqual({ args: ['--ide'], env: { CLAUDE_CODE_SSE_PORT: '4567' } });
  });
});
