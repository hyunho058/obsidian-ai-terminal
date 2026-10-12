import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { PROFILE_LABELS, TERMINAL_VIEW_TYPE, type PluginContext, type ProfileId, type SessionState, type TerminalViewState } from '../core';
import type { MirrorSnapshot } from '../session/mirror';
import { isProfileId, newPanelId, PROFILE_ICONS } from '../session/profiles';
import type { SessionHandle, SessionsService, TerminalSink, TerminalSize } from '../session/types';
import { createLinkActivator } from './links';
import { resolveTheme } from './theme';

/** State accepted by `setState`: the persisted fields plus `launch: 'new'`, set only by the open commands. */
export interface TerminalViewSetState extends Partial<TerminalViewState> {
  launch?: 'new';
}

/** What the terminal module gives each view. */
export interface TerminalViewHost {
  readonly ctx: PluginContext;
  readonly sessions: SessionsService;
  /** True once Obsidian started tearing the plugin down (views must not start sessions any more). */
  isTearingDown(): boolean;
  /** Once per view, when it gets its first state. */
  viewOpened(view: TerminalView): void;
  viewClosed(view: TerminalView): void;
}

/** Fit runs at most this long after a size change (R1.8: the PTY gets the new size within 500 ms). */
const FIT_DEBOUNCE_MS = 30;

type MigratableElement = HTMLElement & { onWindowMigrated?: (listener: (win: Window) => void) => () => void };

/**
 * A terminal panel (D4, D9). The program lives in the session registry (D34); this view owns only the visible xterm
 * and attaches to the session named by its view state `{profile, panelId, sessionId}`. Moving the panel keeps the
 * same view (Obsidian re-parents the leaf); moving it into another window rebuilds the xterm from the mirror.
 */
export class TerminalView extends ItemView {
  private _profile: ProfileId = 'shell';
  private _panelId: string | null = null;
  private _sessionId: string | undefined;
  /** panelId this view attached under (may be pending as a possible duplicate, D21). */
  private attachedId: string | null = null;
  private term: Terminal | undefined;
  private fitAddon: FitAddon | undefined;
  private hostEl: HTMLElement | undefined;
  private termDisposers: Array<() => void> = [];
  private resizeObserver: ResizeObserver | undefined;
  private fitTimer: { win: Window; id: number } | undefined;
  private viewClosed = false;
  /** `viewOpened` was reported (after the first state, so profile / panelId are known). */
  private announced = false;
  private readonly sink: TerminalSink;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: TerminalViewHost,
  ) {
    super(leaf);
    const currentTerm = () => this.term;
    this.sink = {
      get terminal() {
        return currentTerm();
      },
      write: (data) => this.term?.write(data),
      restore: (snapshot) => this.restore(snapshot),
      measure: () => this.measure(),
      identityChanged: (identity) => this.onIdentityChanged(identity),
      stateChanged: (state) => this.onSessionState(state),
    };
  }

  // ------------------------------------------------------------------ public API (T4 close flow, T10 …)

  get panelId(): string | null {
    return this._panelId;
  }

  get profile(): ProfileId {
    return this._profile;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /** "Claude Code" / "Antigravity" / "Shell". */
  get label(): string {
    return PROFILE_LABELS[this._profile];
  }

  get terminal(): Terminal | undefined {
    return this.term;
  }

  /** True after `onClose` started (the view is going away; do not ask about it any more). */
  get isClosed(): boolean {
    return this.viewClosed;
  }

  /** The session this view shows, once it is attached to it (undefined while a possible duplicate is pending). */
  get session(): SessionHandle | undefined {
    if (!this.attachedId || !this.term) return undefined;
    const session = this.host.sessions.get(this.attachedId);
    return session && session.terminal === this.term ? session : undefined;
  }

  /** The program is starting or running — closing should ask first (D26). */
  isRunning(): boolean {
    return this.session?.isRunning ?? false;
  }

  focusTerminal(): void {
    this.term?.focus();
  }

  // ------------------------------------------------------------------ Obsidian View

  getViewType(): string {
    return TERMINAL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.label;
  }

  getIcon(): string {
    return PROFILE_ICONS[this._profile];
  }

  getState(): Record<string, unknown> {
    const state: Record<string, unknown> = { ...super.getState(), profile: this._profile };
    if (this._panelId) state.panelId = this._panelId;
    if (this._sessionId) state.sessionId = this._sessionId;
    return state;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state && typeof state === 'object' ? state : {}) as TerminalViewSetState;
    const incoming = typeof s.panelId === 'string' && s.panelId ? s.panelId : null;
    let phase: 'new' | 'restore' = s.launch === 'new' ? 'new' : 'restore';
    if (!(incoming && incoming === this.attachedId)) {
      if (isProfileId(s.profile)) this._profile = s.profile;
      if (incoming) {
        this._panelId = incoming;
        this._sessionId = typeof s.sessionId === 'string' && s.sessionId ? s.sessionId : undefined;
      } else if (!this._panelId) {
        this._panelId = newPanelId();
        this._sessionId = undefined;
        phase = 'new';
      }
    }
    await super.setState(state, result);
    this.attach(phase);
  }

  setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    if (state && typeof state === 'object' && (state as { focus?: unknown }).focus) this.focusTerminal();
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('ai-terminal-view');
    const hostEl = this.contentEl.createDiv({ cls: 'ai-terminal-container' });
    this.hostEl = hostEl;
    this.registerEvent(this.app.workspace.on('css-change', () => this.applyTheme()));
    const migratable = hostEl as MigratableElement;
    if (typeof migratable.onWindowMigrated === 'function') {
      this.register(migratable.onWindowMigrated(() => this.rebuildTerminal()));
    }
    this.ensureTerminal();
  }

  async onClose(): Promise<void> {
    this.viewClosed = true;
    if (this.attachedId) this.host.sessions.detach(this.attachedId, this.sink);
    this.disposeTerminal();
    if (this.announced) this.host.viewClosed(this);
  }

  onResize(): void {
    this.scheduleFit();
  }

  // ------------------------------------------------------------------ settings / theme

  /** Applies the terminal colors (R2.8; called on `css-change` and when the Terminal colors setting changes). */
  applyTheme(): void {
    if (this.term && this.hostEl) this.term.options.theme = this.currentTheme(this.hostEl);
  }

  /** The xterm theme for the Terminal colors setting; the area around the grid gets the same background. */
  private currentTheme(hostEl: HTMLElement): ITheme {
    const theme = resolveTheme(hostEl, this.host.ctx.settings.terminalColors);
    hostEl.style.backgroundColor = this.host.ctx.settings.terminalColors === 'obsidian' ? '' : theme.background ?? '';
    return theme;
  }

  /** Applies font, scrollback and Option-as-Meta from the settings to the open xterm. */
  applySettings(): void {
    const term = this.term;
    if (!term) return;
    const s = this.host.ctx.settings;
    term.options.fontFamily = s.fontFamily;
    term.options.fontSize = s.fontSize;
    term.options.scrollback = s.scrollback;
    term.options.macOptionIsMeta = s.optionIsMeta;
    this.scheduleFit();
  }

  /**
   * Replaces the xterm with a fresh one restored from the session mirror. Runs when the panel moved into another
   * window (popout) — xterm keeps references to the old window's document.
   */
  rebuildTerminal(): void {
    if (this.viewClosed || !this.hostEl) return;
    this.disposeTerminal();
    this.hostEl.empty();
    this.ensureTerminal();
    if (this.attachedId) this.host.sessions.refresh(this.attachedId, this.sink);
  }

  /** Fits the xterm to the panel and sends the size to the session (PTY + mirror). */
  fitNow(): void {
    const term = this.term;
    const dims = this.measure();
    if (!term || !dims) return;
    if (dims.cols !== term.cols || dims.rows !== term.rows) term.resize(dims.cols, dims.rows);
    if (this.session && this.attachedId) this.host.sessions.resize(this.attachedId, term.cols, term.rows);
  }

  /** Size that fits the panel, or null while the panel has no size. */
  measure(): TerminalSize | null {
    const dims = this.fitAddon?.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 1) return null;
    return { cols: dims.cols, rows: dims.rows };
  }

  // ------------------------------------------------------------------ internals

  private attach(phase: 'new' | 'restore'): void {
    const panelId = this._panelId;
    if (this.viewClosed || !panelId || this.host.isTearingDown() || this.attachedId === panelId) return;
    if (this.attachedId) this.host.sessions.detach(this.attachedId, this.sink);
    this.attachedId = panelId;
    this.ensureTerminal();
    if (!this.announced) {
      this.announced = true;
      this.host.viewOpened(this);
    }
    this.host.sessions.attach({ panelId, profile: this._profile, sessionId: this._sessionId, phase, sink: this.sink });
  }

  private onIdentityChanged(identity: { panelId: string; sessionId: string | undefined }): void {
    this._panelId = identity.panelId;
    this.attachedId = identity.panelId;
    this._sessionId = identity.sessionId;
    this.app.workspace.requestSaveLayout();
  }

  private onSessionState(state: SessionState): void {
    this.hostEl?.toggleClass('is-ended', state === 'exited' || state === 'stopped');
  }

  private window(): Window {
    return this.hostEl?.ownerDocument.defaultView ?? window;
  }

  private ensureTerminal(): void {
    const hostEl = this.hostEl;
    if (this.term || this.viewClosed || !hostEl) return;
    const s = this.host.ctx.settings;
    const activate = createLinkActivator(() => this.window());
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      scrollback: s.scrollback,
      macOptionIsMeta: s.optionIsMeta,
      macOptionClickForcesSelection: true,
      drawBoldTextInBrightColors: true,
      theme: this.currentTheme(hostEl),
      linkHandler: { activate: (event, text) => activate(event, text), allowNonHttpProtocols: false },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon(activate));
    // Keyboard routing belongs to T4: its handlers return true to consume a key event (xterm then ignores it).
    term.attachCustomKeyEventHandler((event) => {
      const session = this.session;
      return session ? !this.host.ctx.keyboard.dispatchKey(event, session) : true;
    });
    const onData = term.onData((data) => this.input(data));
    const onBinary = term.onBinary((data) => this.input(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
    this.termDisposers.push(
      () => onData.dispose(),
      () => onBinary.dispose(),
    );
    term.open(hostEl);
    this.term = term;
    this.fitAddon = fitAddon;
    const RO = (this.window() as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (RO) {
      const observer = new RO(() => this.scheduleFit());
      observer.observe(hostEl);
      this.resizeObserver = observer;
    }
    this.scheduleFit();
  }

  private input(data: string | Uint8Array): void {
    if (this.attachedId && this.session) this.host.sessions.write(this.attachedId, data);
  }

  private async restore(snapshot: MirrorSnapshot): Promise<void> {
    const term = this.term;
    if (!term) return;
    term.reset();
    term.resize(Math.max(1, snapshot.cols), Math.max(1, snapshot.rows));
    await new Promise<void>((resolve) => term.write(snapshot.data, resolve));
    if (this.term === term) this.fitNow();
  }

  private scheduleFit(): void {
    if (this.fitTimer || !this.term) return;
    const win = this.window();
    const id = win.setTimeout(() => {
      this.fitTimer = undefined;
      this.fitNow();
    }, FIT_DEBOUNCE_MS);
    this.fitTimer = { win, id };
  }

  private disposeTerminal(): void {
    if (this.fitTimer) this.fitTimer.win.clearTimeout(this.fitTimer.id);
    this.fitTimer = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    for (const dispose of this.termDisposers.splice(0)) dispose();
    this.term?.dispose();
    this.term = undefined;
    this.fitAddon = undefined;
  }
}
