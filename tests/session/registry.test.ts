import { afterEach, describe, expect, it } from 'vitest';
import { PythonNotFoundError } from '../../src/pty/python';
import {
  DUPLICATE_WINDOW_MS,
  GRACE_MS,
  NUDGE_DELAY_MS,
  START_FAILED_PROMPT,
  STARTING_TEXT,
  STOPPED_PROMPT,
  exitPrompt,
} from '../../src/session/SessionRegistry';
import { FakeSink, makeHarness, sleep, waitFor, type Harness } from './helpers';

const FAST = { graceMs: 120, duplicateWindowMs: 60, nudgeDelayMs: 5 };

let current: Harness | null = null;
async function harness(opts: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  current = await makeHarness({ registry: FAST, ...opts });
  return current;
}

afterEach(() => {
  current?.registry?.dispose();
  current?.runtime.unload();
  current = null;
});

async function started(h: Harness, panelId = 'p1', sink = new FakeSink(), profile: 'claude' | 'agy' | 'shell' = 'shell') {
  const outcome = h.registry.attach({ panelId, profile, phase: 'new', sink });
  await waitFor(() => h.registry.get(panelId)?.state === 'running');
  return { outcome, sink, proc: h.pty.last, session: h.registry.get(panelId)! };
}

describe('SessionRegistry — spawn flow', () => {
  it('uses the spec timings by default', () => {
    expect([GRACE_MS, DUPLICATE_WINDOW_MS]).toEqual([2_000, 1_000]);
    expect(NUDGE_DELAY_MS).toBeLessThan(500);
  });

  it('runs ready → beforeSpawn → contributors → spawning → spawn → started, in that order (R0.1, R1.6)', async () => {
    const h = await harness();
    const order: string[] = [];
    h.ctx.settings.profiles.claude = { command: 'claude', args: '--model sonnet' };
    h.ctx.sessionEvents.beforeSpawn((c) => {
      order.push(`before:${c.phase}:${c.profile}`);
      c.print('hook line');
    });
    h.ctx.spawn.add('test', (c) => {
      order.push(`contrib:${c.command}:${c.baseArgs.join(' ')}`);
      return { args: ['--extra'], env: { FOO: 'bar' }, notice: 'a notice', sessionId: 'sid-1' };
    });
    h.ctx.sessionEvents.on('session:spawning', () => order.push(`spawning:${h.pty.calls.length}`));
    h.ctx.sessionEvents.on('session:started', () => order.push(`started:${h.pty.calls.length}`));
    const sink = new FakeSink();
    sink.size = { cols: 120, rows: 40 };
    expect(h.registry.attach({ panelId: 'p1', profile: 'claude', phase: 'new', sink })).toBe('created');
    await waitFor(() => h.registry.get('p1')?.state === 'running');
    expect(order).toEqual(['before:new:claude', 'contrib:claude:--model sonnet', 'spawning:0', 'started:1']);
    const call = h.pty.calls[0]!;
    expect(call).toMatchObject({ command: 'claude', args: ['--model', 'sonnet', '--extra'], env: { FOO: 'bar' }, cwd: h.ctx.vaultPath, cols: 120, rows: 40 });
    expect(sink.text()).toContain('hook line\r\n');
    expect(sink.text()).toContain('a notice\r\n');
    expect(sink.identities).toEqual([{ panelId: 'p1', sessionId: 'sid-1' }]);
    const session = h.registry.get('p1')!;
    expect(session.sessionId).toBe('sid-1');
    expect(session.label).toBe('Claude Code');
    expect(session.isRunning).toBe(true);
    expect(session.pid).toBe(h.pty.last.programPid);
    const startedEvent = h.events.find((e) => e[0] === 'session:started')!;
    expect(startedEvent[1]).toMatchObject({ panelId: 'p1', profile: 'claude', sessionId: 'sid-1', phase: 'new', pid: h.pty.last.programPid });
    expect(h.registry.mirrorOf('p1')).toMatchObject({ cols: 120, rows: 40 });
  });

  it('session:started carries the program pid once the helper reports it', async () => {
    const h = await harness();
    h.pty.onSpawn = (proc) => {
      const real = proc.programPid;
      proc.programPid = undefined;
      setTimeout(() => (proc.programPid = real), 25);
    };
    const { proc } = await started(h);
    await waitFor(() => h.events.some((e) => e[0] === 'session:started'));
    expect(h.events.find((e) => e[0] === 'session:started')![1]).toMatchObject({ pid: proc.programPid });
    expect(proc.programPid).not.toBe(proc.pid);
  });

  it('session:started is emitted before session:exited even when the program exits at once', async () => {
    const h = await harness();
    h.pty.onSpawn = (proc) => {
      proc.programPid = undefined;
      queueMicrotask(() => proc.exit(0));
    };
    const sink = new FakeSink();
    h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'new', sink });
    await waitFor(() => sink.text().includes(exitPrompt(0)));
    expect(h.events.map((e) => e[0])).toEqual(['session:spawning', 'session:started', 'session:exited']);
    expect(h.events[1]![1]).toMatchObject({ pid: h.pty.last.pid });
  });

  it('starts the shell profile as a login shell from settings (R5.11, D3)', async () => {
    const h = await harness();
    h.ctx.settings.profiles.shell = { command: '/bin/zsh', args: '-l' };
    await started(h, 'p1', new FakeSink(), 'shell');
    expect(h.pty.calls[0]).toMatchObject({ command: '/bin/zsh', args: ['-l'] });
  });

  it('feeds output to the view and the mirror; prints the exit prompt and emits session:exited (R5.1)', async () => {
    const h = await harness();
    const { sink, proc } = await started(h);
    proc.emitData('hello\r\n');
    await waitFor(() => sink.text().includes('hello'));
    proc.exit(0);
    await waitFor(() => sink.text().includes(exitPrompt(0)));
    expect(sink.text()).toContain('[Process exited with code 0 — press Enter to restart]');
    expect(h.registry.get('p1')!.state).toBe('exited');
    const exited = h.events.find((e) => e[0] === 'session:exited')!;
    expect(exited[1]).toMatchObject({ panelId: 'p1', exitCode: 0 });
    expect((exited[1] as { runtimeMs: number }).runtimeMs).toBeGreaterThanOrEqual(0);
    const mirror = h.registry.mirrorOf('p1')!;
    await mirror.flush();
    const lines: string[] = [];
    for (let i = 0; i < mirror.terminal.buffer.active.length; i++) lines.push(mirror.terminal.buffer.active.getLine(i)!.translateToString(true));
    expect(lines).toContain('hello');
    expect(lines).toContain(exitPrompt(0));
  });

  it('prints the settings hint before the prompt when the command is missing (R3.4)', async () => {
    const h = await harness();
    h.ctx.settings.profiles.claude = { command: 'claudex', args: '' };
    const { sink, proc } = await started(h, 'p1', new FakeSink(), 'claude');
    proc.exit(127, { notFound: true, execError: { errno: 2, code: 'ENOENT', message: 'No such file' } });
    await waitFor(() => sink.text().includes(exitPrompt(127)));
    expect(sink.text()).toContain('Command not found: claudex — check Settings › Profiles\r\n[Process exited with code 127');
  });

  it('leaves the alternate screen and resets input modes after an exit', async () => {
    const h = await harness();
    const { sink, proc } = await started(h);
    proc.emitData('\x1b[?1049h\x1b[?2004h\x1b[?1hTUI');
    proc.exit(1);
    await waitFor(() => sink.text().includes(exitPrompt(1)));
    const mirror = h.registry.mirrorOf('p1')!;
    await mirror.flush();
    expect(mirror.terminal.buffer.active.type).toBe('normal');
    expect(mirror.terminal.modes.bracketedPasteMode).toBe(false);
    expect(mirror.terminal.modes.applicationCursorKeysMode).toBe(false);
  });

  it('Enter in an exited panel restarts the same profile in the same panel (R5.2)', async () => {
    const h = await harness();
    const phases: string[] = [];
    h.ctx.sessionEvents.beforeSpawn((c) => {
      phases.push(c.phase);
    });
    const { sink, proc } = await started(h);
    proc.emitData('old output\r\n');
    proc.exit(0);
    await waitFor(() => sink.text().includes(exitPrompt(0)));
    h.registry.write('p1', 'x'); // other keys are ignored
    expect(h.pty.spawned).toHaveLength(1);
    h.registry.write('p1', '\r');
    await waitFor(() => h.pty.spawned.length === 2 && h.registry.get('p1')!.state === 'running');
    expect(phases).toEqual(['new', 'restart']);
    expect(h.pty.last.command).toBe(proc.command);
    expect(h.events.filter((e) => e[0] === 'session:spawning').map((e) => (e[1] as { phase: string }).phase)).toEqual(['new', 'restart']);
    // Earlier output stays in the panel (same mirror).
    const snap = await h.registry.mirrorOf('p1')!.snapshot();
    expect(snap.data).toContain('old output');
  });

  it('sendInput("\\r") also restarts an exited panel (T4 Enter dispatcher path)', async () => {
    const h = await harness();
    const { sink, proc, session } = await started(h);
    proc.exit(2);
    await waitFor(() => sink.text().includes(exitPrompt(2)));
    session.sendInput('\r');
    await waitFor(() => h.pty.spawned.length === 2);
  });

  it('respawns once with the fallback arguments when the program fails quickly (agy --continue, R5.10)', async () => {
    const h = await harness();
    h.ctx.spawn.add('resume', () => ({
      replaceArgs: ['--continue'],
      args: ['--bridge'],
      fallback: { withinMs: 5_000, replaceArgs: [], notice: '[Previous conversation not found — starting a new one]' },
    }));
    const { sink, proc } = await started(h, 'p1', new FakeSink(), 'agy');
    expect(proc.args).toEqual(['--continue', '--bridge']);
    proc.exit(1);
    await waitFor(() => h.pty.spawned.length === 2 && h.registry.get('p1')!.state === 'running');
    expect(h.pty.last.args).toEqual(['--bridge']);
    expect(sink.text()).toContain('[Previous conversation not found — starting a new one]\r\n');
    expect(sink.text()).not.toContain('press Enter');
    // Only once: the second quick failure shows the normal exit prompt.
    h.pty.last.exit(1);
    await waitFor(() => sink.text().includes(exitPrompt(1)));
    expect(h.pty.spawned).toHaveLength(2);
  });

  it('does not fall back after a successful exit or a slow failure', async () => {
    const h = await harness();
    h.ctx.spawn.add('resume', () => ({ fallback: { withinMs: 30, replaceArgs: ['plain'] } }));
    const { sink, proc } = await started(h, 'p1', new FakeSink(), 'agy');
    await sleep(60);
    proc.exit(1);
    await waitFor(() => sink.text().includes(exitPrompt(1)));
    expect(h.pty.spawned).toHaveLength(1);
  });

  it('shows the Python error in the panel and spawns nothing (R2.5)', async () => {
    const h = await harness();
    h.pty.failWith = new PythonNotFoundError([]);
    const sink = new FakeSink();
    h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'new', sink });
    await waitFor(() => h.registry.get('p1')?.state === 'exited');
    expect(sink.text()).toContain('Python 3 not found — install it or set the path in Settings\r\n');
    expect(sink.text()).toContain(START_FAILED_PROMPT);
    expect(h.pty.spawned).toHaveLength(0);
    expect(h.events.map((e) => e[0])).toEqual(['session:spawning', 'session:exited']);
    // Enter retries.
    h.pty.failWith = null;
    h.registry.write('p1', '\r');
    await waitFor(() => h.registry.get('p1')?.state === 'running');
  });

  it('waits for the ready gate and shows "Starting…" meanwhile (R6.7)', async () => {
    const h = await harness({ gated: true });
    const sink = new FakeSink();
    h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'new', sink });
    await sleep(30);
    expect(sink.text()).toContain(STARTING_TEXT);
    expect(h.pty.calls).toHaveLength(0);
    expect(h.registry.get('p1')!.state).toBe('starting');
    h.release();
    await waitFor(() => h.registry.get('p1')?.state === 'running');
    expect(h.pty.calls).toHaveLength(1);
    // The "Starting…" line is erased when the program starts.
    expect(sink.text()).toMatch(/Starting…\x1b\[0m\r\x1b\[2K/);
  });

  it('drops input while starting and forwards it once running', async () => {
    const h = await harness({ gated: true });
    const sink = new FakeSink();
    h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'new', sink });
    h.registry.write('p1', 'early\r');
    h.release();
    await waitFor(() => h.registry.get('p1')?.state === 'running');
    h.registry.write('p1', 'ls\r');
    expect(h.pty.last.input()).toBe('ls\r');
  });

  it('a stop during startup cancels the spawn', async () => {
    const h = await harness({ gated: true });
    const sink = new FakeSink();
    h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'new', sink });
    await h.registry.stop('p1', 'close');
    h.release();
    await sleep(30);
    expect(h.pty.calls).toHaveLength(0);
    expect(h.registry.get('p1')!.state).toBe('stopped');
  });
});

describe('SessionRegistry — input holds', () => {
  it('queues typed input in order while held; sendInput bypasses; nested holds flush on the last release', async () => {
    const h = await harness();
    const { proc, session } = await started(h);
    const outer = session.holdInput();
    h.registry.write('p1', 'a');
    const inner = session.holdInput();
    h.registry.write('p1', 'b');
    session.sendInput('\r');
    expect(proc.input()).toBe('\r');
    inner();
    h.registry.write('p1', 'c');
    expect(proc.input()).toBe('\r');
    inner(); // idempotent
    outer();
    expect(proc.input()).toBe('\rabc');
    h.registry.write('p1', 'd');
    expect(proc.input()).toBe('\rabcd');
  });

  it('print() writes locally only', async () => {
    const h = await harness();
    const { proc, sink, session } = await started(h);
    session.print('local\r\n');
    expect(sink.text()).toContain('local\r\n');
    expect(proc.input()).toBe('');
  });
});

describe('SessionRegistry — resize, reattach, grace, duplicates', () => {
  it('resizes PTY and mirror together and ignores unchanged sizes (R1.8, R6.4)', async () => {
    const h = await harness();
    const { proc } = await started(h);
    h.registry.resize('p1', 90, 30);
    expect(proc.resizes).toEqual([[90, 30]]);
    expect(h.registry.mirrorOf('p1')).toMatchObject({ cols: 90, rows: 30 });
    h.registry.resize('p1', 90, 30);
    expect(proc.resizes).toEqual([[90, 30]]);
  });

  it('reattach within the grace period keeps the process, restores the screen and nudges a redraw (R6.1–R6.3)', async () => {
    const h = await harness();
    const { sink, proc } = await started(h);
    proc.emitData('\x1b[?2004hreply in progress');
    await waitFor(() => sink.text().includes('reply in progress'));
    h.registry.detach('p1', sink);
    expect(h.registry.get('p1')!.attached).toBe(false);
    proc.emitData(' more');
    await sleep(20);
    const moved = new FakeSink('moved');
    moved.size = { cols: 80, rows: 20 };
    moved.onRestore = () => h.registry.resize('p1', 80, 20); // the view fits after restoring
    expect(h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'restore', sink: moved })).toBe('reattached');
    await waitFor(() => proc.resizes.length >= 3);
    expect(h.pty.spawned).toHaveLength(1);
    expect(proc.killReason).toBeUndefined();
    expect(moved.restores).toHaveLength(1);
    expect(moved.restores[0]!.data).toContain('reply in progress more');
    expect(moved.restores[0]!.data).toContain('\x1b[?2004h');
    expect(moved.restores[0]).toMatchObject({ cols: 100, rows: 30 });
    // fit (80×20), then one column narrower and back.
    expect(proc.resizes).toEqual([
      [80, 20],
      [79, 20],
      [80, 20],
    ]);
    expect(h.registry.mirrorOf('p1')).toMatchObject({ cols: 80, rows: 20 });
    expect(h.events.filter((e) => e[0] === 'session:spawning')).toHaveLength(1);
    await sleep(FAST.graceMs + 30);
    expect(h.registry.get('p1')!.state).toBe('running');
    // Input now goes through the new view.
    h.registry.write('p1', 'x');
    expect(proc.input()).toBe('x');
  });

  it('output that arrives while restoring is replayed after the restore, exactly once', async () => {
    const h = await harness();
    const { sink, proc } = await started(h);
    h.registry.detach('p1', sink);
    const moved = new FakeSink('moved');
    moved.onRestore = async () => {
      proc.emitData('during');
      await sleep(10);
    };
    h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'restore', sink: moved });
    await waitFor(() => moved.text().includes('during'));
    proc.emitData('after');
    expect(moved.restores[0]!.data).not.toContain('during');
    expect(moved.text()).toBe('duringafter');
  });

  it('stops the session through the helper when no view returns within the grace period (R6.6)', async () => {
    const h = await harness();
    const { sink, proc } = await started(h);
    h.registry.detach('p1', sink);
    await sleep(FAST.graceMs / 2);
    expect(proc.killReason).toBeUndefined();
    await waitFor(() => proc.killReason !== undefined, FAST.graceMs * 3);
    expect(proc.killReason).toBe('detached');
    expect(h.registry.get('p1')).toBeUndefined();
    const stopped = h.events.find((e) => e[0] === 'session:stopped')!;
    expect(stopped[1]).toMatchObject({ panelId: 'p1', reason: 'detached' });
    await waitFor(() => h.events.some((e) => e[0] === 'session:exited'));
  });

  it('old view first: detach then attach within the grace period is a move', async () => {
    const h = await harness();
    const { sink, proc } = await started(h);
    h.registry.detach('p1', sink);
    const b = new FakeSink('b');
    expect(h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'restore', sink: b })).toBe('reattached');
    await waitFor(() => b.restores.length === 1);
    expect(h.pty.spawned).toEqual([proc]);
  });

  it('new view first: the old view detaching within the duplicate window makes it a move', async () => {
    const h = await harness();
    const { sink, proc } = await started(h);
    const b = new FakeSink('b');
    expect(h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'restore', sink: b })).toBe('pending');
    h.registry.write('p1', 'still old view');
    await sleep(FAST.duplicateWindowMs / 3);
    h.registry.detach('p1', sink);
    await waitFor(() => b.restores.length === 1);
    expect(b.identities).toEqual([]);
    expect(h.pty.spawned).toEqual([proc]);
    await sleep(FAST.duplicateWindowMs + 30);
    expect(h.pty.spawned).toHaveLength(1);
    expect(h.registry.list().map((s) => s.panelId)).toEqual(['p1']);
  });

  it('a view still open after the window is a duplicate: the new view gets a new panelId and a fresh session (R6.5)', async () => {
    const h = await harness();
    h.ctx.spawn.add('sid', (c) => ({ sessionId: c.sessionId ?? `fresh-${c.panelId}` }));
    const sink = new FakeSink('a');
    h.registry.attach({ panelId: 'p1', profile: 'claude', sessionId: 'conv-a', phase: 'restore', sink });
    await waitFor(() => h.registry.get('p1')?.state === 'running');
    const original = h.pty.last;
    const dup = new FakeSink('dup');
    expect(h.registry.attach({ panelId: 'p1', profile: 'claude', sessionId: 'conv-a', phase: 'restore', sink: dup })).toBe('pending');
    await waitFor(() => h.pty.spawned.length === 2, 2_000);
    const newId = dup.identities[0]!.panelId;
    expect(newId).not.toBe('p1');
    expect(dup.identities[0]!.sessionId).toBeUndefined();
    await waitFor(() => h.registry.get(newId)?.state === 'running');
    const fresh = h.registry.get(newId)!;
    expect(fresh.sessionId).toBe(`fresh-${newId}`);
    const spawning = h.events.filter((e) => e[0] === 'session:spawning').map((e) => e[1]);
    expect(spawning[1]).toMatchObject({ panelId: newId, phase: 'new' });
    // The original keeps its session.
    expect(h.registry.get('p1')!.sessionId).toBe('conv-a');
    expect(original.killReason).toBeUndefined();
    h.registry.write(newId, 'n');
    h.registry.write('p1', 'o');
    expect(h.pty.last.input()).toBe('n');
    expect(original.input()).toBe('o');
  });

  it('a pending duplicate that closes inside the window is forgotten', async () => {
    const h = await harness();
    const { sink } = await started(h);
    const dup = new FakeSink('dup');
    h.registry.attach({ panelId: 'p1', profile: 'shell', phase: 'restore', sink: dup });
    h.registry.detach('p1', dup);
    await sleep(FAST.duplicateWindowMs + 30);
    expect(h.pty.spawned).toHaveLength(1);
    expect(dup.identities).toEqual([]);
    expect(h.registry.get('p1')!.attached).toBe(true);
    void sink;
  });

  it('refresh() restores the same view again (xterm rebuilt after a window move)', async () => {
    const h = await harness();
    const { sink, proc } = await started(h);
    proc.emitData('screen');
    h.registry.refresh('p1', sink);
    await waitFor(() => sink.restores.length === 1 && proc.resizes.length === 2);
    expect(sink.restores[0]!.data).toContain('screen');
    expect(proc.resizes).toEqual([
      [99, 30],
      [100, 30],
    ]);
    h.registry.refresh('p1', new FakeSink('other'));
    await sleep(10);
    expect(sink.restores).toHaveLength(1);
  });
});

describe('SessionRegistry — stop, ids, events, unload', () => {
  it('stop() with a view attached keeps the panel, prints a prompt and Enter restarts', async () => {
    const h = await harness();
    const { sink, proc, session } = await started(h);
    const done = h.registry.stop('p1', 'restore');
    expect(session.state).toBe('stopped');
    expect(proc.killReason).toBe('restore');
    await done;
    expect(sink.text()).toContain(STOPPED_PROMPT);
    expect(h.registry.get('p1')).toBe(session);
    expect(h.events.map((e) => e[0])).toEqual(['session:spawning', 'session:started', 'session:stopped', 'session:exited']);
    h.registry.write('p1', '\r');
    await waitFor(() => h.pty.spawned.length === 2 && session.state === 'running');
  });

  it('a stopped session is forgotten when its view detaches', async () => {
    const h = await harness();
    const { sink } = await started(h);
    await h.registry.stop('p1', 'close');
    h.registry.detach('p1', sink);
    expect(h.registry.get('p1')).toBeUndefined();
  });

  it('restart() of a running program stops it first, then spawns with phase restart', async () => {
    const h = await harness();
    const { proc } = await started(h);
    await h.registry.restart('p1');
    expect(proc.killReason).toBe('restart');
    await waitFor(() => h.registry.get('p1')?.state === 'running');
    expect(h.pty.spawned).toHaveLength(2);
  });

  it('setSessionId notifies the attached view and listeners (T5)', async () => {
    const h = await harness();
    const changes: unknown[] = [];
    h.registry.on('session-id', (c) => changes.push(c));
    const { sink } = await started(h, 'p1', new FakeSink(), 'claude');
    h.registry.setSessionId('p1', 'uuid-2');
    h.registry.setSessionId('p1', 'uuid-2');
    expect(sink.identities).toEqual([{ panelId: 'p1', sessionId: 'uuid-2' }]);
    expect(changes).toEqual([{ panelId: 'p1', profile: 'claude', sessionId: 'uuid-2' }]);
    expect(h.registry.get('p1')!.sessionId).toBe('uuid-2');
  });

  it('emits state changes to the view and to listeners', async () => {
    const h = await harness();
    const states: string[] = [];
    h.registry.on('state', (c) => states.push(`${c.previous}>${c.state}`));
    const { sink, proc } = await started(h);
    proc.exit(0);
    await waitFor(() => sink.states.includes('exited'));
    expect(sink.states).toEqual(['running', 'exited']);
    expect(states).toEqual(['starting>running', 'running>exited']);
  });

  it('list() returns live sessions; clear() empties the mirror', async () => {
    const h = await harness();
    const { session, proc } = await started(h, 'a');
    await started(h, 'b');
    expect(h.registry.list().map((s) => s.panelId)).toEqual(['a', 'b']);
    proc.emitData('one\r\ntwo\r\n');
    session.clear();
    const snap = await h.registry.mirrorOf('a')!.snapshot();
    expect(snap.data).not.toContain('one');
  });

  it('dispose() stops every session quietly and ignores later attaches (R7.7, R7.8)', async () => {
    const h = await harness();
    const a = await started(h, 'a');
    const b = await started(h, 'b');
    h.registry.dispose();
    expect(a.proc.killReason).toBe('unload');
    expect(b.proc.killReason).toBe('unload');
    expect(h.registry.list()).toEqual([]);
    expect(a.sink.text()).not.toContain(STOPPED_PROMPT);
    expect(h.registry.attach({ panelId: 'c', profile: 'shell', phase: 'new', sink: new FakeSink() })).toBe('unchanged');
    await sleep(10);
    expect(h.pty.spawned).toHaveLength(2);
  });
});
