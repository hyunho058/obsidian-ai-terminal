import { ButtonComponent, Modal, WorkspaceLeaf, type App } from 'obsidian';
import type { SessionsService } from '../session/types';
import type { Logger } from '../util/log';
import { openModalIn } from '../util/modal';
import type { TerminalViewsService } from './index';
import type { TerminalView } from './TerminalView';

/** "Stop and close" waits at most this long for the program to end (the helper hard-kills after 5 s) before closing. */
export const STOP_WAIT_MS = 6_000;

/** "Claude Code is still running — stop it and close?" / "2 terminals are still running — stop them and close?" */
export function closeQuestion(labels: readonly string[]): string {
  return labels.length === 1
    ? `${labels[0]} is still running — stop it and close?`
    : `${labels.length} terminals are still running — stop them and close?`;
}

export interface CloseRequest {
  /** Profile labels of the running panels, in close order. */
  labels: string[];
  /** Window of the panels (the dialog opens there — popout windows have their own document). */
  win: Window | null;
}

/** Shows the confirmation; resolves true for "Stop and close", false for Cancel / Escape. */
export type ConfirmClose = (request: CloseRequest) => Promise<boolean>;

/** Confirmation dialog of the close flow (D26). Closing it without a choice counts as Cancel. */
export class ConfirmCloseModal extends Modal {
  stopButton: ButtonComponent | null = null;
  cancelButton: ButtonComponent | null = null;
  private answered = false;

  constructor(
    app: App,
    readonly labels: readonly string[],
    private readonly answer: (stop: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ai-terminal-close-dialog');
    contentEl.createEl('p', { text: closeQuestion(this.labels) });
    if (this.labels.length > 1) {
      const list = contentEl.createEl('ul');
      for (const label of this.labels) list.createEl('li', { text: label });
    }
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    this.stopButton = new ButtonComponent(buttons)
      .setButtonText('Stop and close')
      .setDestructive()
      .onClick(() => this.choose(true));
    this.cancelButton = new ButtonComponent(buttons).setButtonText('Cancel').onClick(() => this.choose(false));
    this.stopButton.buttonEl?.focus?.();
  }

  onClose(): void {
    this.contentEl.empty();
    this.settle(false);
  }

  /** Answers (first answer wins) and closes the dialog. */
  choose(stop: boolean): void {
    this.settle(stop);
    this.close();
  }

  private settle(stop: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.answer(stop);
  }
}

/** Moved to `src/util/modal.ts`; re-exported here for existing imports. */
export { openModalIn };

export interface CloseFlowOptions {
  app: App;
  terminals: TerminalViewsService;
  sessions: SessionsService;
  log: Logger;
  /** Plugin teardown in progress (disable / unload): never ask (R7.8). */
  isTearingDown(): boolean;
  stopWaitMs?: number;
  /** Replaces the dialog (tests). */
  confirm?: ConfirmClose;
}

interface PendingClose {
  leaf: WorkspaceLeaf;
  view: TerminalView;
}

type DetachFn = (this: WorkspaceLeaf) => void;

interface WorkspaceInternals {
  layoutReady?: boolean;
  /** Internal (app.js 1.14): the leaf's root is one of the four top-level splits. */
  isAttached?(leaf: WorkspaceLeaf): boolean;
  rootSplit?: unknown;
  leftSplit?: unknown;
  rightSplit?: unknown;
  floatingSplit?: unknown;
}

/**
 * The close flow (D26, R7.3–R7.8): wraps `WorkspaceLeaf.prototype.detach` so that closing a terminal whose program runs
 * asks first. Every detach in the same tick (tab menu "Close others" / "Close all" are synchronous loops) is grouped into
 * one dialog. Detaches that Obsidian performs on its own — quit, popout-window close, workspace-layout load, plugin
 * disable, drag — pass straight through.
 */
export class CloseFlow {
  private original: DetachFn | null = null;
  private wrapper: DetachFn | null = null;
  private active = false;
  private quitting = false;
  private pending: PendingClose[] = [];
  /** Leaves with an open dialog or a stop in progress (a repeated close is ignored meanwhile). */
  private readonly asking = new Set<WorkspaceLeaf>();
  /** Leaves this flow is detaching itself after "Stop and close". */
  private readonly bypass = new Set<WorkspaceLeaf>();
  private readonly dialogs = new Set<ConfirmCloseModal>();
  private readonly log: Logger;

  constructor(private readonly options: CloseFlowOptions) {
    this.log = options.log;
  }

  get installed(): boolean {
    return this.active;
  }

  install(): void {
    if (this.original) return;
    const proto = WorkspaceLeaf.prototype as unknown as { detach: DetachFn };
    const original = proto.detach;
    const shouldAsk = (leaf: WorkspaceLeaf) => this.shouldAsk(leaf);
    const wrapper: DetachFn = function (this: WorkspaceLeaf): void {
      if (shouldAsk(this)) return;
      original.call(this);
    };
    proto.detach = wrapper;
    this.original = original;
    this.wrapper = wrapper;
    this.active = true;
  }

  /** Restores `detach` (or, if something wrapped it after us, leaves our wrapper in place as a pass-through). */
  uninstall(): void {
    this.active = false;
    this.pending = [];
    for (const dialog of [...this.dialogs]) dialog.choose(false);
    const proto = WorkspaceLeaf.prototype as unknown as { detach: DetachFn };
    if (this.original && proto.detach === this.wrapper) proto.detach = this.original;
    this.original = null;
    this.wrapper = null;
  }

  /** Obsidian is quitting (`workspace` "quit"): no dialogs from now on (R7.7). */
  markQuitting(): void {
    this.quitting = true;
  }

  /** True while Obsidian is closing panels on its own (quit, layout load, unload, drag): no dialog. */
  isSilent(): boolean {
    const { app } = this.options;
    const ws = app.workspace as unknown as WorkspaceInternals;
    if (this.quitting || this.options.isTearingDown() || ws.layoutReady === false) return true;
    const drag = (app as unknown as { dragManager?: { draggable?: unknown } }).dragManager;
    return !!drag?.draggable;
  }

  /**
   * False when the leaf is no longer part of the workspace tree. Closing a popout window detaches the window from the
   * workspace first and only then detaches its leaves (app.js `WorkspaceWindow.close`), so those detaches see this.
   */
  isAttached(leaf: WorkspaceLeaf): boolean {
    const ws = this.options.app.workspace as unknown as WorkspaceInternals;
    if (typeof ws.isAttached === 'function') return ws.isAttached(leaf);
    const getRoot = (leaf as unknown as { getRoot?: () => unknown }).getRoot;
    if (typeof getRoot !== 'function') return true;
    const roots = [ws.rootSplit, ws.leftSplit, ws.rightSplit, ws.floatingSplit].filter((r) => r);
    return roots.length === 0 || roots.includes(getRoot.call(leaf));
  }

  /** The detach wrapper's decision: true = the detach waits for the user's answer. */
  private shouldAsk(leaf: WorkspaceLeaf): boolean {
    if (!this.active || this.bypass.has(leaf)) return false;
    const view = this.options.terminals.viewOfLeaf(leaf);
    if (!view || view.isClosed || !view.isRunning()) return false;
    if (this.isSilent() || !this.isAttached(leaf)) return false;
    if (this.asking.has(leaf) || this.pending.some((p) => p.leaf === leaf)) return true;
    this.pending.push({ leaf, view });
    if (this.pending.length === 1) queueMicrotask(() => this.flush());
    return true;
  }

  private flush(): void {
    const batch = this.pending.splice(0).filter((p) => this.stillOpen(p));
    if (!this.active || batch.length === 0) return;
    for (const p of batch) this.asking.add(p.leaf);
    const request: CloseRequest = { labels: batch.map((p) => p.view.label), win: windowOf(batch[0].view) };
    const confirm = this.options.confirm ?? ((r: CloseRequest) => this.ask(r));
    void Promise.resolve()
      .then(() => confirm(request))
      .then((stop) => (stop && this.active ? this.stopAndClose(batch) : undefined))
      .catch((err) => this.log.error('close flow failed', err))
      .finally(() => {
        for (const p of batch) this.asking.delete(p.leaf);
      });
  }

  private ask(request: CloseRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const modal = new ConfirmCloseModal(this.options.app, request.labels, (stop) => {
        this.dialogs.delete(modal);
        resolve(stop);
      });
      this.dialogs.add(modal);
      openModalIn(modal, request.win);
    });
  }

  /** "Stop and close": stop each program (helper shutdown, D8), then close its panel. */
  private async stopAndClose(batch: PendingClose[]): Promise<void> {
    await Promise.all(
      batch.map(async (p) => {
        if (!this.stillOpen(p)) return;
        const panelId = p.view.session?.panelId ?? p.view.panelId;
        if (panelId && p.view.isRunning()) await this.stop(panelId);
        if (!this.stillOpen(p)) return;
        this.bypass.add(p.leaf);
        try {
          p.leaf.detach();
        } finally {
          this.bypass.delete(p.leaf);
        }
      }),
    );
  }

  private async stop(panelId: string): Promise<void> {
    const waitMs = this.options.stopWaitMs ?? STOP_WAIT_MS;
    let timer: number | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = window.setTimeout(() => resolve('timeout'), waitMs);
    });
    try {
      const outcome = await Promise.race([this.options.sessions.stop(panelId, 'close').then(() => 'stopped' as const), timeout]);
      if (outcome === 'timeout') this.log.warn(`panel ${panelId}: program still running ${waitMs} ms after stop — closing anyway`);
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  private stillOpen(p: PendingClose): boolean {
    return !p.view.isClosed && p.leaf.view === p.view;
  }
}

function windowOf(view: TerminalView): Window | null {
  return (view.containerEl as HTMLElement | undefined)?.ownerDocument?.defaultView ?? null;
}
