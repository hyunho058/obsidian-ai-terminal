import { PROFILE_LABELS, TypedEmitter, type ProfileId } from '../core';
import type { Disposer, PluginContext, SessionState, SpawnPhase, SpawnPlan } from '../core';
import type { PtyExit, PtyProcess } from '../pty/PtyProcess';
import { formatSpawnFailure } from '../pty/messages';
import { redact, type Logger } from '../util/log';
import { TerminalMirror } from './mirror';
import { launchCommand, newPanelId } from './profiles';
import type {
  AttachOutcome,
  AttachRequest,
  SessionHandle,
  SessionRegistryEvents,
  SessionsService,
  TerminalSink,
  TerminalSize,
} from './types';

/** A detached session waits this long for a view with its panelId before it is stopped (D34, R6.6). */
export const GRACE_MS = 2_000;
/** A second view with an attached panelId is a move if the first one detaches within this window, else a duplicate (D21). */
export const DUPLICATE_WINDOW_MS = 1_000;
/** Pause between "one column narrower" and "back" when forcing a redraw after a reattach (R6.3). */
export const NUDGE_DELAY_MS = 80;

export const STARTING_TEXT = 'Starting…';
export const STOPPED_PROMPT = '[Process stopped — press Enter to restart]';
export const START_FAILED_PROMPT = '[Could not start — press Enter to retry]';

/** R5.1: `[Process exited with code N — press Enter to restart]`. */
export function exitPrompt(exitCode: number | null): string {
  return exitCode === null ? '[Process exited — press Enter to restart]' : `[Process exited with code ${exitCode} — press Enter to restart]`;
}

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };
/** Longest wait for the helper to report the program's pid before `session:started` is emitted with the helper's. */
const PROGRAM_PID_WAIT_MS = 300;
const CLEAR_LINE = '\r\x1b[2K';
/** Input modes an exited (or crashed) program may have left on; reset so the prompt and the next program start sane. */
const RESET_INPUT_MODES = '\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l';

export interface SessionRegistryOptions {
  graceMs?: number;
  duplicateWindowMs?: number;
  nudgeDelayMs?: number;
}

interface PendingAttach {
  sink: TerminalSink;
  profile: ProfileId;
  /** The conversation id the attaching view has stored (its view state). */
  sessionId: string | undefined;
  timer: ReturnType<typeof setTimeout>;
}

/** What a session needs from its registry. */
interface SessionHost {
  readonly ctx: PluginContext;
  readonly log: Logger;
  readonly nudgeDelayMs: number;
  emit<K extends keyof SessionRegistryEvents>(event: K, payload: SessionRegistryEvents[K]): void;
  restart(session: Session): void;
}

function hasEnter(data: string | Uint8Array): boolean {
  return typeof data === 'string' ? data.includes('\r') : data.includes(13);
}

/** One panel's program: PTY process, headless mirror and input holds (D34). Implements `TerminalPanelHandle`. */
class Session implements SessionHandle {
  readonly label: string;
  sink: TerminalSink | null = null;
  readonly pending: PendingAttach[] = [];
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  readonly mirror: TerminalMirror;

  private _state: SessionState = 'starting';
  private _sessionId: string | undefined;
  private _startedAt: number | undefined;
  private proc: PtyProcess | null = null;
  /** Data listener of the current process (the exit listener stays: `session:exited` is emitted even after a stop). */
  private dataListener: Disposer | undefined;
  private plan: SpawnPlan | null = null;
  private fallback: SpawnPlan['fallback'];
  /** Bumped by every launch / stop / restart; async steps of an older generation give up. */
  private gen = 0;
  private holds = 0;
  private held: Array<string | Uint8Array> = [];
  /** Output produced while a restore is in progress (replayed after it, so nothing is lost or doubled). */
  private outQueue: Array<string | Uint8Array> | null = null;
  private restoreGen = 0;
  private startingShown = false;
  private disposed = false;
  private target: TerminalSize = { ...DEFAULT_SIZE };
  private applied: TerminalSize = { ...DEFAULT_SIZE };
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: SessionHost,
    readonly panelId: string,
    readonly profile: ProfileId,
    sessionId: string | undefined,
  ) {
    this.label = PROFILE_LABELS[profile];
    this._sessionId = sessionId;
    this.mirror = new TerminalMirror({ ...DEFAULT_SIZE, scrollback: host.ctx.settings.scrollback });
  }

  // ------------------------------------------------------------------ TerminalPanelHandle / SessionHandle

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get state(): SessionState {
    return this._state;
  }

  get terminal() {
    return this.sink?.terminal;
  }

  get isRunning(): boolean {
    return this._state === 'starting' || this._state === 'running';
  }

  get pid(): number | undefined {
    return this.proc?.programPid;
  }

  get attached(): boolean {
    return this.sink !== null;
  }

  get startedAt(): number | undefined {
    return this._startedAt;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  sendInput(data: string): void {
    if (!this.disposed) this.deliver(data);
  }

  /** Local text (notices, notes, failure lines) — secrets are redacted here, so no caller can print a token. */
  print(text: string): void {
    if (this.disposed) return;
    this.clearStarting();
    this.output(redact(text));
  }

  holdInput(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
      if (this.holds === 0 && !this.disposed) for (const data of this.held.splice(0)) this.deliver(data);
    };
  }

  clear(): void {
    this.sink?.terminal?.clear();
    this.mirror.clear();
  }

  // ------------------------------------------------------------------ registry API

  /** User input from the view (typing, paste, xterm query replies). */
  input(data: string | Uint8Array): void {
    if (this.disposed) return;
    if (this.holds > 0) this.held.push(data);
    else this.deliver(data);
  }

  setSink(sink: TerminalSink | null): void {
    this.sink = sink;
    if (!sink) {
      this.outQueue = null;
      this.restoreGen++;
    }
  }

  setSessionId(sessionId: string | undefined): void {
    if (sessionId === this._sessionId || this.disposed) return;
    this._sessionId = sessionId;
    this.sink?.identityChanged({ panelId: this.panelId, sessionId });
    this.host.emit('session-id', { panelId: this.panelId, profile: this.profile, sessionId });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || !Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    this.target = { cols: Math.floor(cols), rows: Math.floor(rows) };
    if (this.nudgeTimer === undefined) this.apply(this.target);
  }

  /** Restores `sink` from the mirror, replays output that arrived meanwhile, then forces a redraw (D34, R6.1–R6.3). */
  async restoreInto(sink: TerminalSink): Promise<void> {
    const token = ++this.restoreGen;
    // Output from here on is queued for the view; everything before is in the snapshot (taken in the same tick).
    this.outQueue = [];
    const snapshot = await this.mirror.snapshot();
    const current = (): boolean => !this.disposed && this.sink === sink && token === this.restoreGen;
    if (!current()) return;
    try {
      await sink.restore(snapshot);
    } catch (err) {
      this.host.log.error('restoring the terminal screen failed', err);
    }
    if (!current()) return;
    const queued = this.outQueue ?? [];
    this.outQueue = null;
    for (const data of queued) sink.write(data);
    this.nudge();
  }

  /** Spawn flow (INTERFACES "Launcher order"): ready gate → beforeSpawn → contributors → spawn. */
  async launch(phase: SpawnPhase): Promise<void> {
    const gen = ++this.gen;
    this.fallback = undefined;
    this.setState('starting');
    const { ctx } = this.host;
    if (!ctx.isReady()) {
      this.showStarting();
      await ctx.ready;
      if (!this.current(gen)) return;
    }
    await ctx.sessionEvents.runBeforeSpawn({
      panelId: this.panelId,
      profile: this.profile,
      sessionId: this._sessionId,
      phase,
      vaultPath: ctx.vaultPath,
      print: (line) => this.print(`${line}\r\n`),
    });
    if (!this.current(gen)) return;
    const { command, baseArgs } = launchCommand(ctx.settings, this.profile);
    let plan: SpawnPlan;
    try {
      plan = await ctx.spawn.resolve({
        profile: this.profile,
        panelId: this.panelId,
        sessionId: this._sessionId,
        vaultPath: ctx.vaultPath,
        phase,
        command,
        baseArgs,
      });
    } catch (err) {
      if (this.current(gen)) this.startFailed(err);
      return;
    }
    if (!this.current(gen)) return;
    if (plan.sessionId !== this._sessionId) this.setSessionId(plan.sessionId);
    for (const notice of plan.notices) this.print(`${notice}\r\n`);
    this.plan = plan;
    this.fallback = plan.fallback;
    await this.spawn(gen, phase, plan.args);
  }

  /** Ends the program (helper shutdown) and marks the session stopped. Resolves when the process has exited. */
  stop(reason: string): Promise<void> {
    const proc = this.proc;
    const wasActive = this.isRunning;
    this.gen++;
    this.proc = null;
    this.held = [];
    this.cancelNudge();
    this.clearStarting();
    if (this._state !== 'stopped') {
      this.setState('stopped');
      this.host.ctx.sessionEvents.emit('session:stopped', { ...this.base(), reason });
    }
    if (proc && !proc.hasExited) proc.kill(reason);
    if (wasActive && this.sink && reason !== 'unload') this.print(`\r\n${STOPPED_PROMPT}\r\n`);
    return proc ? proc.exited.then(() => undefined) : Promise.resolve();
  }

  /** Enter-to-restart and `sessions.restart`: same profile, same panel, phase `restart` (R5.2). */
  async restart(): Promise<void> {
    if (this.disposed) return;
    const proc = this.proc;
    if (proc) {
      const gen = ++this.gen;
      this.proc = null;
      this.cancelNudge();
      this.setState('starting');
      proc.kill('restart');
      await proc.exited;
      if (!this.current(gen)) return;
    }
    await this.launch('restart');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gen++;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.cancelNudge();
    this.dataListener?.();
    this.dataListener = undefined;
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.hasExited) proc.kill('disposed');
    this.held = [];
    this.outQueue = null;
    this.sink = null;
    this.mirror.dispose();
  }

  // ------------------------------------------------------------------ internals

  private current(gen: number): boolean {
    return !this.disposed && gen === this.gen;
  }

  private base(): { panelId: string; profile: ProfileId; sessionId: string | undefined } {
    return { panelId: this.panelId, profile: this.profile, sessionId: this._sessionId };
  }

  private setState(state: SessionState): void {
    const previous = this._state;
    if (previous === state) return;
    this._state = state;
    this.sink?.stateChanged?.(state);
    this.host.emit('state', { panelId: this.panelId, profile: this.profile, state, previous });
  }

  private output(data: string | Uint8Array): void {
    this.mirror.write(data);
    if (this.outQueue) this.outQueue.push(data);
    else this.sink?.write(data);
  }

  private showStarting(): void {
    if (this.startingShown) return;
    this.startingShown = true;
    this.output(`\x1b[2m${STARTING_TEXT}\x1b[0m`);
  }

  private clearStarting(): void {
    if (!this.startingShown) return;
    this.startingShown = false;
    this.output(CLEAR_LINE);
  }

  private deliver(data: string | Uint8Array): void {
    if (this._state === 'running') this.proc?.write(data);
    else if ((this._state === 'exited' || this._state === 'stopped') && hasEnter(data)) this.host.restart(this);
    // 'starting': dropped — an early Enter must not answer a prompt the program has not shown yet.
  }

  private apply(size: TerminalSize): void {
    if (size.cols === this.applied.cols && size.rows === this.applied.rows) return;
    this.applied = { ...size };
    this.mirror.resize(size.cols, size.rows);
    this.proc?.resize(size.cols, size.rows);
  }

  /** Same-size TIOCSWINSZ sends no SIGWINCH — go one column narrower and back to make the program redraw. */
  private nudge(): void {
    const proc = this.proc;
    if (!proc || this._state !== 'running') return;
    this.cancelNudge();
    const { cols, rows } = this.target;
    this.apply({ cols: cols > 2 ? cols - 1 : cols + 1, rows });
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      if (!this.disposed && this.proc === proc) this.apply(this.target);
    }, this.host.nudgeDelayMs);
  }

  private cancelNudge(): void {
    if (this.nudgeTimer === undefined) return;
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
    if (!this.disposed) this.apply(this.target);
  }

  private async spawn(gen: number, phase: SpawnPhase, args: string[]): Promise<void> {
    const { ctx } = this.host;
    const plan = this.plan;
    if (!plan) return;
    const measured = this.sink?.measure();
    if (measured) this.target = { ...measured };
    this.apply(this.target);
    ctx.sessionEvents.emit('session:spawning', { ...this.base(), phase });
    let proc: PtyProcess;
    try {
      const pty = ctx.services.get('pty');
      if (!pty) throw new Error('The terminal helper is not available — see the developer console');
      proc = await pty.spawn({
        command: plan.command,
        args,
        env: plan.env,
        cwd: ctx.vaultPath,
        cols: this.applied.cols,
        rows: this.applied.rows,
      });
    } catch (err) {
      if (this.current(gen)) this.startFailed(err);
      return;
    }
    if (!this.current(gen)) {
      proc.kill('stopped before start');
      return;
    }
    this.proc = proc;
    this._startedAt = Date.now();
    this.clearStarting();
    const startedAt = this._startedAt;
    this.dataListener?.();
    this.dataListener = proc.on('data', (chunk) => {
      if (!this.disposed && this.proc === proc) this.output(chunk);
    });
    this.setState('running');
    const announce = this.announceStarted(proc, phase);
    proc.on('exit', (exit) => {
      announce();
      this.onExit(proc, exit, phase, startedAt);
    });
  }

  /**
   * Emits `session:started` with the program's pid. The helper reports it on stderr shortly after the spawn, so
   * wait up to `PROGRAM_PID_WAIT_MS` for it (falling back to the helper's pid). Returns a function that emits
   * immediately (used when the program exits first).
   */
  private announceStarted(proc: PtyProcess, phase: SpawnPhase): () => void {
    const payload = { ...this.base(), phase };
    let timer: ReturnType<typeof setInterval> | undefined;
    let done = false;
    const emit = (): void => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      this.host.ctx.sessionEvents.emit('session:started', { ...payload, pid: proc.programPid ?? proc.pid });
    };
    if (proc.programPid !== undefined) {
      emit();
      return emit;
    }
    const deadline = Date.now() + PROGRAM_PID_WAIT_MS;
    timer = setInterval(() => {
      if (proc.programPid !== undefined || proc.hasExited || Date.now() >= deadline) emit();
    }, 10);
    return emit;
  }

  private onExit(proc: PtyProcess, exit: PtyExit, phase: SpawnPhase, startedAt: number): void {
    const runtimeMs = Date.now() - startedAt;
    this.host.ctx.sessionEvents.emit('session:exited', { ...this.base(), exitCode: exit.exitCode, runtimeMs });
    if (this.disposed || proc !== this.proc || this._state !== 'running') return;
    this.proc = null;
    this.cancelNudge();
    const fallback = this.fallback;
    this.fallback = undefined;
    if (fallback && exit.exitCode !== null && exit.exitCode !== 0 && !exit.killReason && runtimeMs <= fallback.withinMs) {
      if (fallback.notice) this.print(`${fallback.notice}\r\n`);
      this.setState('starting');
      void this.spawn(this.gen, phase, fallback.args);
      return;
    }
    void this.showExit(exit);
  }

  private async showExit(exit: PtyExit): Promise<void> {
    this.setState('exited');
    const gen = this.gen;
    await this.mirror.flush();
    if (!this.current(gen) || this._state !== 'exited') return;
    this.output(this.mirror.isAltScreen() ? `\x1b[?1049l${RESET_INPUT_MODES}` : RESET_INPUT_MODES);
    await this.mirror.flush();
    if (!this.current(gen) || this._state !== 'exited') return;
    const lines: string[] = [];
    const failure = formatSpawnFailure(exit);
    if (failure) lines.push(redact(failure));
    lines.push(exitPrompt(exit.exitCode));
    this.output(`${this.mirror.cursorX() > 0 ? '\r\n' : ''}${lines.join('\r\n')}\r\n`);
  }

  private startFailed(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.host.log.warn(`could not start ${this.label}: ${message}`);
    this.print(`${redact(message)}\r\n${START_FAILED_PROMPT}\r\n`);
    this.setState('exited');
    this.host.ctx.sessionEvents.emit('session:exited', { ...this.base(), exitCode: null, runtimeMs: 0 });
  }
}

/**
 * Plugin-level session registry keyed by panelId (D34): owns every program, its headless mirror and state; views
 * attach and detach. Published as the `sessions` service.
 */
export class SessionRegistry implements SessionsService {
  private readonly sessions = new Map<string, Session>();
  private readonly emitter: TypedEmitter<SessionRegistryEvents>;
  private readonly log: Logger;
  private readonly graceMs: number;
  private readonly duplicateWindowMs: number;
  private readonly host: SessionHost;
  private disposed = false;

  constructor(
    private readonly ctx: PluginContext,
    options: SessionRegistryOptions = {},
  ) {
    this.log = ctx.log.child('session');
    this.graceMs = options.graceMs ?? GRACE_MS;
    this.duplicateWindowMs = options.duplicateWindowMs ?? DUPLICATE_WINDOW_MS;
    this.emitter = new TypedEmitter<SessionRegistryEvents>((m, e) => this.log.error(m, e));
    const registry = this;
    this.host = {
      ctx,
      log: this.log,
      nudgeDelayMs: options.nudgeDelayMs ?? NUDGE_DELAY_MS,
      emit: (event, payload) => registry.emitter.emit(event, payload),
      restart: (session) => {
        void session.restart().catch((err) => registry.log.error('restart failed', err));
      },
    };
  }

  get(panelId: string): SessionHandle | undefined {
    return this.sessions.get(panelId);
  }

  list(): SessionHandle[] {
    return [...this.sessions.values()];
  }

  attach(request: AttachRequest): AttachOutcome {
    if (this.disposed) return 'unchanged';
    const { panelId, sink } = request;
    const session = this.sessions.get(panelId);
    if (!session) {
      const created = new Session(this.host, panelId, request.profile, request.sessionId);
      this.sessions.set(panelId, created);
      created.setSink(sink);
      this.emitter.emit('attach', { panelId, profile: created.profile, reattached: false });
      void created.launch(request.phase).catch((err) => this.log.error('launch failed', err));
      return 'created';
    }
    if (session.sink === sink) return 'unchanged';
    if (session.pending.some((p) => p.sink === sink)) return 'pending';
    if (!session.sink) {
      this.takeOver(session, sink, request.sessionId);
      return 'reattached';
    }
    // Another open view holds this panel: a move if that view detaches within the window, else a duplicate (D21).
    const pending: PendingAttach = {
      sink,
      profile: request.profile,
      sessionId: request.sessionId,
      timer: setTimeout(() => this.resolveDuplicate(session, pending), this.duplicateWindowMs),
    };
    session.pending.push(pending);
    return 'pending';
  }

  detach(panelId: string, sink: TerminalSink): void {
    const session = this.sessions.get(panelId);
    if (!session) return;
    const i = session.pending.findIndex((p) => p.sink === sink);
    if (i >= 0) {
      clearTimeout(session.pending[i]!.timer);
      session.pending.splice(i, 1);
      return;
    }
    if (session.sink !== sink) return;
    session.setSink(null);
    this.emitter.emit('detach', { panelId, profile: session.profile });
    const next = session.pending.shift();
    if (next) {
      // The other view opened first and this one is closing: it was a move.
      clearTimeout(next.timer);
      this.takeOver(session, next.sink, next.sessionId);
      return;
    }
    if (session.state === 'stopped') {
      this.remove(session);
      return;
    }
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = setTimeout(() => {
      session.graceTimer = undefined;
      if (!session.sink && this.sessions.get(panelId) === session) void this.stop(panelId, 'detached');
    }, this.graceMs);
  }

  refresh(panelId: string, sink: TerminalSink): void {
    const session = this.sessions.get(panelId);
    if (session && session.sink === sink) void session.restoreInto(sink);
  }

  stop(panelId: string, reason: string): Promise<void> {
    const session = this.sessions.get(panelId);
    if (!session) return Promise.resolve();
    const done = session.stop(reason);
    if (!session.sink && session.pending.length === 0) this.remove(session);
    return done;
  }

  stopAll(reason: string): void {
    for (const session of [...this.sessions.values()]) {
      void session.stop(reason);
      this.remove(session);
    }
  }

  async restart(panelId: string): Promise<void> {
    const session = this.sessions.get(panelId);
    if (session && !this.disposed) await session.restart();
  }

  write(panelId: string, data: string | Uint8Array): void {
    this.sessions.get(panelId)?.input(data);
  }

  resize(panelId: string, cols: number, rows: number): void {
    this.sessions.get(panelId)?.resize(cols, rows);
  }

  setSessionId(panelId: string, sessionId: string | undefined): void {
    this.sessions.get(panelId)?.setSessionId(sessionId);
  }

  on<K extends keyof SessionRegistryEvents>(event: K, listener: (payload: SessionRegistryEvents[K]) => void): Disposer {
    return this.emitter.on(event, listener);
  }

  /** The session's headless mirror (tests / diagnostics). */
  mirrorOf(panelId: string): TerminalMirror | undefined {
    return this.sessions.get(panelId)?.mirror;
  }

  /** Plugin unload: stops every session quietly and ignores later attaches. Synchronous. */
  dispose(): void {
    if (this.disposed) return;
    this.stopAll('unload');
    this.disposed = true;
    this.emitter.clear();
  }

  /**
   * `viewSessionId` = the conversation id the new view has stored. If the session's id changed since that view saved
   * its state (e.g. a resume picked a new id while the panel was moving), the view is told, so it persists the right id.
   */
  private takeOver(session: Session, sink: TerminalSink, viewSessionId: string | undefined): void {
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = undefined;
    session.setSink(sink);
    if (session.sessionId !== viewSessionId) sink.identityChanged({ panelId: session.panelId, sessionId: session.sessionId });
    this.emitter.emit('attach', { panelId: session.panelId, profile: session.profile, reattached: true });
    void session.restoreInto(sink).catch((err) => this.log.error('reattach failed', err));
  }

  private resolveDuplicate(session: Session, pending: PendingAttach): void {
    const i = session.pending.indexOf(pending);
    if (i < 0) return;
    session.pending.splice(i, 1);
    if (this.disposed) return;
    if (this.sessions.get(session.panelId) === session && !session.sink) {
      this.takeOver(session, pending.sink, pending.sessionId);
      return;
    }
    const panelId = newPanelId();
    this.log.debug(`panel ${session.panelId} is open twice — the new view becomes panel ${panelId}`);
    this.emitter.emit('duplicate', { panelId: session.panelId, newPanelId: panelId, profile: pending.profile });
    pending.sink.identityChanged({ panelId, sessionId: undefined });
    this.attach({ panelId, profile: pending.profile, phase: 'new', sink: pending.sink });
  }

  private remove(session: Session): void {
    for (const p of session.pending.splice(0)) clearTimeout(p.timer);
    if (this.sessions.get(session.panelId) === session) this.sessions.delete(session.panelId);
    session.dispose();
    this.emitter.emit('removed', { panelId: session.panelId, profile: session.profile });
  }
}
