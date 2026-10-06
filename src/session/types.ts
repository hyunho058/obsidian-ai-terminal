import type { Terminal } from '@xterm/xterm';
import type { ProfileId } from '../core/constants';
import type { Disposer, SessionState, SpawnPhase, TerminalPanelHandle } from '../core/types';
import type { MirrorSnapshot } from './mirror';

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * What a terminal view gives the registry when it attaches (implemented by `TerminalView`). The registry writes
 * program output into it and restores it from the session's headless mirror.
 */
export interface TerminalSink {
  /** The view's xterm (exposed as `TerminalPanelHandle.terminal`). */
  readonly terminal: Terminal | undefined;
  /** Program output or local text. */
  write(data: string | Uint8Array): void;
  /**
   * Replaces the view's screen with a mirror snapshot: size the xterm to `cols`×`rows`, write `data`, then fit to
   * the view (which reports its size through `SessionsService.resize`). Resolves when done.
   */
  restore(snapshot: MirrorSnapshot): Promise<void>;
  /** Columns/rows that fit the view right now, or null while it has no size (hidden). */
  measure(): TerminalSize | null;
  /**
   * The panel's identity changed — a duplicate got a new `panelId` (D21) or the conversation id changed
   * (`setSessionId`, spawn contributors). The view stores it in its view state and asks Obsidian to save the layout.
   */
  identityChanged(identity: { panelId: string; sessionId: string | undefined }): void;
  /** Optional: session state changed (starting → running → exited / stopped). */
  stateChanged?(state: SessionState): void;
}

export interface AttachRequest {
  panelId: string;
  profile: ProfileId;
  sessionId?: string;
  /** Used only when this attach creates a new session: `new` (command) or `restore` (layout, view rebuild). */
  phase: Exclude<SpawnPhase, 'restart'>;
  sink: TerminalSink;
}

/**
 * - `created`: a new session was created and is starting;
 * - `reattached`: the view took over a detached session (screen restored from the mirror, no restart);
 * - `pending`: another open view holds this panelId — decided within the duplicate window (D21);
 * - `unchanged`: this sink is already attached.
 */
export type AttachOutcome = 'created' | 'reattached' | 'pending' | 'unchanged';

/** A live session as seen by other modules (`sessions.get` / `sessions.list`). */
export interface SessionHandle extends TerminalPanelHandle {
  /** `PROFILE_LABELS[profile]`, e.g. "Claude Code". */
  readonly label: string;
  /** state is `starting` or `running` (a close should ask first, D26). */
  readonly isRunning: boolean;
  /** pid of the program (session leader inside the PTY) while it runs. */
  readonly pid: number | undefined;
  /** A view is attached (false during the reattach grace period). */
  readonly attached: boolean;
  /** Epoch ms of the last `session:started`. */
  readonly startedAt: number | undefined;
  /** Clears scrollback + screen of the attached xterm and the mirror (Cmd+K, R4.4) so a later move does not bring it back. */
  clear(): void;
}

export interface SessionStateChange {
  panelId: string;
  profile: ProfileId;
  state: SessionState;
  previous: SessionState;
}

export interface SessionIdChange {
  panelId: string;
  profile: ProfileId;
  sessionId: string | undefined;
}

/** Registry-level notifications (in addition to `ctx.sessionEvents`). */
export interface SessionRegistryEvents {
  state: SessionStateChange;
  'session-id': SessionIdChange;
  /** A view attached; `reattached` = it took over a running session (move / view rebuild). */
  attach: { panelId: string; profile: ProfileId; reattached: boolean };
  detach: { panelId: string; profile: ProfileId };
  /** A duplicated view got a fresh panel id (D21). */
  duplicate: { panelId: string; newPanelId: string; profile: ProfileId };
  /** The registry forgot a session (stopped with no view attached, or plugin unload). */
  removed: { panelId: string; profile: ProfileId };
}

/** The `sessions` service (T3, D34). */
export interface SessionsService {
  get(panelId: string): SessionHandle | undefined;
  list(): SessionHandle[];
  /** Called by a terminal view after it knows its state (see `AttachOutcome`). */
  attach(request: AttachRequest): AttachOutcome;
  /** Called by a terminal view when it closes. Starts the 2 s grace period (D34) unless the session is stopped. */
  detach(panelId: string, sink: TerminalSink): void;
  /** The attached view rebuilt its xterm (moved to another window): restore it from the mirror and nudge. */
  refresh(panelId: string, sink: TerminalSink): void;
  /**
   * Stops the program (helper shutdown, D8) and marks the session `stopped`. Without an attached view the session is
   * forgotten. Resolves when the process has exited. Never shows a dialog.
   */
  stop(panelId: string, reason: string): Promise<void>;
  /** Stops every session (plugin unload / disable). Synchronous; no dialogs, no messages. */
  stopAll(reason: string): void;
  /** Starts the profile again in the same panel (phase `restart`); a running program is stopped first. */
  restart(panelId: string): Promise<void>;
  /** User input (typing, paste, xterm replies): queued while `holdInput` is active; Enter in an ended panel restarts. */
  write(panelId: string, data: string | Uint8Array): void;
  /** New size of the attached view: resizes the PTY and the mirror together (R1.8, R6.4). Unchanged sizes are ignored. */
  resize(panelId: string, cols: number, rows: number): void;
  /** Updates the conversation id; the attached view persists it in its view state (T5). */
  setSessionId(panelId: string, sessionId: string | undefined): void;
  on<K extends keyof SessionRegistryEvents>(event: K, listener: (payload: SessionRegistryEvents[K]) => void): Disposer;
}

declare module '../core/services' {
  interface ServiceMap {
    sessions: SessionsService;
  }
}
