import { Modal, View, type App } from 'obsidian';
import type { SessionHandle, SessionsService } from '../session/types';
import { openModalIn } from '../terminal/closeFlow';
import { notice, type Logger } from '../util/log';
import { formatTimestamp } from './messages';
import {
  abortedMessage,
  abortedText,
  aiLabel,
  changedCountText,
  restoreSummary,
  runningAiPanels,
  runningWarning,
  snapshotWhat,
  STATUS_ORDER,
  stopPanels,
  type Restorer,
  type RestorePhase,
} from './restore';
import type { ChangedFile, ChangeStatus, SnapshotInfo, SnapshotsService } from './types';

export const RESTORE_TITLE = 'Restore notes from before an AI session';
export const EMPTY_MESSAGE = 'No snapshots yet.';
const SUMMARY_NOTICE_MS = 15_000;
/** Characters of the prompt shown in a list row (the full excerpt is in the tooltip). */
const ROW_EXCERPT_CHARS = 100;

export const GROUP_TITLES: Readonly<Record<ChangeStatus, string>> = {
  modified: 'Changed since — back to the snapshot version',
  deleted: 'Deleted since — will be brought back',
  created: 'Created since — will move to trash',
};

const STATUS_HINTS: Readonly<Record<ChangeStatus, string>> = {
  modified: 'modified',
  deleted: 'deleted',
  created: 'will move to trash',
};

export interface RestoreModalOptions {
  snapshots: SnapshotsService;
  sessions: () => SessionsService | undefined;
  restorer: Restorer;
  log: Logger;
  /** `settings.snapshots.enabled` (for the empty-state hint). */
  snapshotsSetting?: () => boolean | null;
  /** Snapshot rows shown before "Show older snapshots" (default 50). */
  pageSize?: number;
  /** Snapshots counted per `changedSinceMany` call: the first call (fast first paint), then each later one. */
  countBatch?: { first: number; next: number };
  stopWaitMs?: number;
  /** Shows a Notice (tests replace it). */
  notify?: (message: string, timeoutMs?: number) => void;
  onClosed?: () => void;
}

export type RestoreStep = 'loading' | 'list' | 'error' | 'files' | 'running' | 'working' | 'aborted';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** The window of the active leaf (popout windows have their own document), or null. */
export function activeLeafWindow(app: App): Window | null {
  const view = app.workspace.getActiveViewOfType(View);
  const el = view?.containerEl as HTMLElement | undefined;
  return el?.ownerDocument?.defaultView ?? null;
}

/**
 * The restore modal (D33, R13): 1. snapshots newest first (time, AI, prompt excerpt, files changed since — counted
 * progressively); 2. the files changed since the picked snapshot, grouped by status, all ticked; 3. the running-AI
 * warning if needed (R13.6); then the restore itself (`Restorer`), with a summary Notice.
 */
export class RestoreModal extends Modal {
  step: RestoreStep = 'loading';
  snapshotList: SnapshotInfo[] = [];
  /** Files changed since each snapshot (count) — or the error that stopped counting. */
  readonly counts = new Map<string, number | Error>();
  selected: SnapshotInfo | null = null;
  files: ChangedFile[] = [];
  readonly ticked = new Set<string>();
  /** Running AI panels shown in the warning. */
  running: SessionHandle[] = [];
  private shown = 0;
  private counting = false;
  private closed = false;
  private generation = 0;
  private countEls = new Map<string, HTMLElement>();
  private checkboxes = new Map<string, HTMLInputElement>();
  private restoreButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly opts: RestoreModalOptions,
  ) {
    super(app);
  }

  /** Opens the modal in the window of the active leaf. */
  openInActiveWindow(): void {
    openModalIn(this, activeLeafWindow(this.app));
  }

  onOpen(): void {
    this.closed = false;
    this.setTitle(RESTORE_TITLE);
    this.modalEl.addClass('ai-terminal-restore');
    void this.load();
  }

  onClose(): void {
    this.closed = true;
    this.generation++;
    this.contentEl.empty();
    this.opts.onClosed?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---------------------------------------------------------------- step 1: snapshots

  private async load(): Promise<void> {
    const gen = this.begin('loading');
    this.contentEl.createEl('p', { text: 'Loading snapshots…', cls: 'ai-terminal-restore-status' });
    try {
      this.snapshotList = await this.opts.snapshots.list();
    } catch (err) {
      if (!this.isCurrent(gen)) return;
      this.begin('error');
      this.contentEl.createEl('p', { text: `Could not read the snapshots: ${errorText(err)}`, cls: 'ai-terminal-restore-error' });
      this.buttons([['Close', () => this.close()]]);
      return;
    }
    if (this.isCurrent(gen)) this.showList();
  }

  /** Step 1 (R13.1). */
  showList(): void {
    this.begin('list');
    const el = this.contentEl;
    this.countEls.clear();
    if (this.snapshotList.length === 0) {
      const empty = el.createDiv({ cls: 'ai-terminal-restore-empty' });
      empty.createEl('p', { text: EMPTY_MESSAGE });
      empty.createEl('p', {
        cls: 'setting-item-description',
        text:
          this.opts.snapshotsSetting?.() === true
            ? 'A restore point is saved before each message you send to Claude Code or Antigravity, whenever your notes changed since the last one.'
            : 'Turn on "AI session snapshots" in the AI Terminal settings to save a restore point before each message to Claude Code or Antigravity.',
      });
      this.buttons([['Close', () => this.close()]]);
      return;
    }
    el.createEl('p', { cls: 'setting-item-description', text: 'Pick the moment to go back to (newest first). You choose the notes in the next step.' });
    const listEl = el.createDiv({ cls: 'ai-terminal-restore-list' });
    const upTo = Math.min(this.snapshotList.length, Math.max(this.shown, this.pageSize));
    this.shown = 0;
    this.appendRows(listEl, upTo);
    if (this.shown < this.snapshotList.length) {
      const more = el.createEl('button', { text: 'Show older snapshots', cls: 'ai-terminal-restore-more' });
      more.addEventListener('click', () => {
        this.appendRows(listEl, Math.min(this.snapshotList.length, this.shown + this.pageSize));
        if (this.shown >= this.snapshotList.length) more.remove();
        this.pumpCounts();
      });
    }
    this.pumpCounts();
  }

  private get pageSize(): number {
    return Math.max(1, this.opts.pageSize ?? 50);
  }

  private appendRows(listEl: HTMLElement, upTo: number): void {
    for (; this.shown < upTo; this.shown++) this.renderRow(listEl, this.snapshotList[this.shown]!);
  }

  private renderRow(listEl: HTMLElement, info: SnapshotInfo): void {
    const row = listEl.createDiv({
      cls: ['setting-item', 'ai-terminal-restore-snapshot'],
      attr: { tabindex: '0', role: 'button', 'data-commit': info.commit },
    });
    row.style.cursor = 'pointer';
    const infoEl = row.createDiv({ cls: 'setting-item-info' });
    infoEl.createDiv({ cls: 'setting-item-name', text: `${formatTimestamp(new Date(info.time))} · ${aiLabel(info)}` });
    const what = snapshotWhat(info);
    infoEl.createDiv({ cls: ['setting-item-description', 'ai-terminal-restore-what'], text: truncate(what, ROW_EXCERPT_CHARS), attr: { title: what } });
    const control = row.createDiv({ cls: 'setting-item-control' });
    const count = control.createSpan({ cls: 'ai-terminal-restore-count', text: changedCountText(this.counts.get(info.commit)) });
    this.countEls.set(info.commit, count);
    row.addEventListener('click', () => void this.pick(info));
    row.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      void this.pick(info);
    });
  }

  /** Counts "files changed since" for the shown rows, a batch per `changedSinceMany` call, while the list is shown. */
  private pumpCounts(): void {
    if (this.counting) return;
    this.counting = true;
    const batch = this.opts.countBatch ?? { first: 10, next: 25 };
    void (async () => {
      try {
        let first = this.counts.size === 0;
        while (!this.closed && this.step === 'list') {
          const todo = this.snapshotList
            .slice(0, this.shown)
            .filter((s) => !this.counts.has(s.commit))
            .slice(0, Math.max(1, first ? batch.first : batch.next))
            .map((s) => s.commit);
          if (todo.length === 0) break;
          first = false;
          try {
            const result = await this.opts.snapshots.changedSinceMany(todo);
            for (const c of todo) this.counts.set(c, result.get(c)?.length ?? 0);
            this.updateCounts(todo);
          } catch (err) {
            this.opts.log.warn('counting changed files failed', err);
            const failed = err instanceof Error ? err : new Error(String(err));
            const rest = this.snapshotList.slice(0, this.shown).filter((s) => !this.counts.has(s.commit));
            for (const s of rest) this.counts.set(s.commit, failed);
            this.updateCounts(rest.map((s) => s.commit));
            break;
          }
        }
      } finally {
        this.counting = false;
      }
      // Rows added while the last batch ran.
      if (!this.closed && this.step === 'list' && this.snapshotList.slice(0, this.shown).some((s) => !this.counts.has(s.commit))) this.pumpCounts();
    })();
  }

  private updateCounts(commits: readonly string[]): void {
    for (const c of commits) {
      const el = this.countEls.get(c);
      if (!el) continue;
      const value = this.counts.get(c);
      el.setText(changedCountText(value));
      if (value instanceof Error) el.setAttr('title', value.message);
    }
  }

  // ---------------------------------------------------------------- step 2: files

  /** Step 2 (R13.2): the files changed since `info`, all ticked. */
  async pick(info: SnapshotInfo): Promise<void> {
    const gen = this.begin('files');
    this.selected = info;
    this.files = [];
    this.ticked.clear();
    this.renderSnapshotHeader(info);
    this.contentEl.createEl('p', { text: 'Comparing with your notes now…', cls: 'ai-terminal-restore-status' });
    let files: ChangedFile[];
    try {
      files = await this.opts.snapshots.changedSince(info.commit);
    } catch (err) {
      if (!this.isCurrent(gen)) return;
      this.begin('error');
      this.renderSnapshotHeader(info);
      this.contentEl.createEl('p', { text: `Could not compare with your notes: ${errorText(err)}`, cls: 'ai-terminal-restore-error' });
      this.buttons([['Back', () => this.showList()]]);
      return;
    }
    if (!this.isCurrent(gen)) return;
    this.files = files;
    for (const f of files) this.ticked.add(f.path);
    this.counts.set(info.commit, files.length);
    this.showFiles();
  }

  showFiles(): void {
    const info = this.selected;
    if (!info) return this.showList();
    this.begin('files');
    this.checkboxes.clear();
    this.renderSnapshotHeader(info);
    const el = this.contentEl;
    if (this.files.length === 0) {
      el.createEl('p', { text: 'Nothing to restore — your notes match this snapshot.' });
      this.buttons([['Back', () => this.showList()]]);
      return;
    }
    el.createEl('p', {
      cls: 'setting-item-description',
      text: "Ticked notes go back to their version in this snapshot; notes created since then move to Obsidian's trash (.trash). Untick notes you changed yourself and want to keep.",
    });
    const tools = el.createDiv({ cls: 'ai-terminal-restore-tools' });
    tools.createEl('button', { text: 'Select all' }).addEventListener('click', () => this.setAll(true));
    tools.createEl('button', { text: 'Select none' }).addEventListener('click', () => this.setAll(false));
    for (const status of STATUS_ORDER) {
      const group = this.files.filter((f) => f.status === status);
      if (group.length === 0) continue;
      const section = el.createDiv({ cls: ['ai-terminal-restore-group', `ai-terminal-restore-${status}`] });
      section.createEl('h4', { text: `${GROUP_TITLES[status]} (${group.length})` });
      for (const f of group) {
        const label = section.createEl('label', { cls: 'ai-terminal-restore-file', attr: { 'data-status': f.status } });
        label.style.display = 'block';
        const box = label.createEl('input', { type: 'checkbox', attr: { 'data-path': f.path } });
        box.checked = this.ticked.has(f.path);
        box.addEventListener('change', () => {
          if (box.checked) this.ticked.add(f.path);
          else this.ticked.delete(f.path);
          this.updateRestoreButton();
        });
        this.checkboxes.set(f.path, box);
        label.createSpan({ cls: 'ai-terminal-restore-path', text: ` ${f.path} ` });
        label.createSpan({ cls: 'setting-item-description', text: `(${STATUS_HINTS[f.status]})` });
      }
    }
    const [, restore] = this.buttons([
      ['Back', () => this.showList()],
      ['', () => this.confirm(), 'mod-warning'],
    ]);
    this.restoreButton = restore ?? null;
    this.updateRestoreButton();
  }

  /** Select all / none. */
  setAll(ticked: boolean): void {
    this.ticked.clear();
    if (ticked) for (const f of this.files) this.ticked.add(f.path);
    for (const [p, box] of this.checkboxes) box.checked = this.ticked.has(p);
    this.updateRestoreButton();
  }

  /** The ticked files, in list order. */
  chosenFiles(): ChangedFile[] {
    return this.files.filter((f) => this.ticked.has(f.path));
  }

  private updateRestoreButton(): void {
    const button = this.restoreButton;
    if (!button) return;
    const n = this.chosenFiles().length;
    button.setText(n === 0 ? 'Restore' : `Restore ${n} ${n === 1 ? 'note' : 'notes'}`);
    button.disabled = n === 0;
  }

  private renderSnapshotHeader(info: SnapshotInfo): void {
    this.contentEl.createEl('p', {
      cls: 'ai-terminal-restore-header',
      text: `Snapshot from ${formatTimestamp(new Date(info.time))} · ${aiLabel(info)} · ${truncate(snapshotWhat(info), ROW_EXCERPT_CHARS)}`,
    });
  }

  // ---------------------------------------------------------------- step 3: confirm + restore

  /** The Restore button: warns first if AI panels are running (R13.6). */
  confirm(): void {
    const chosen = this.chosenFiles();
    if (chosen.length === 0 || !this.selected) return;
    const running = runningAiPanels(this.opts.sessions());
    if (running.length > 0) this.showRunning(running);
    else void this.runRestore(chosen, []);
  }

  private showRunning(running: SessionHandle[]): void {
    this.begin('running');
    this.running = running;
    const el = this.contentEl;
    el.createEl('p', { text: runningWarning(running.length), cls: 'ai-terminal-restore-warning' });
    const list = el.createEl('ul');
    for (const s of running) list.createEl('li', { text: s.label });
    this.buttons([
      ['Stop them and restore', () => void this.runRestore(this.chosenFiles(), running), 'mod-warning'],
      ['Restore anyway', () => void this.runRestore(this.chosenFiles(), [])],
      ['Cancel', () => this.showFiles()],
    ]);
  }

  /** Stops `stop` (if any), then restores `chosen`; closes with a summary Notice, or shows why it was cancelled. */
  async runRestore(chosen: readonly ChangedFile[], stop: readonly SessionHandle[]): Promise<void> {
    const snapshot = this.selected;
    if (!snapshot || chosen.length === 0) return;
    const notify = this.opts.notify ?? ((m: string, t?: number) => void notice(m, t));
    if (this.opts.restorer.busy) {
      notify('AI Terminal: a restore is already running.');
      return;
    }
    const gen = this.begin('working');
    const status = this.contentEl.createEl('p', { cls: 'ai-terminal-restore-status' });
    const setStatus = (text: string): void => {
      if (this.isCurrent(gen)) status.setText(text);
    };
    if (stop.length > 0) {
      setStatus(stop.length === 1 ? 'Stopping the AI panel…' : `Stopping ${stop.length} AI panels…`);
      await stopPanels(this.opts.sessions(), stop, this.opts.log, this.opts.stopWaitMs);
    }
    const outcome = await this.opts.restorer.restore(this.opts.snapshots, { snapshot, files: chosen }, (phase: RestorePhase) =>
      setStatus(phase === 'snapshot' ? "Saving a 'Before restore' snapshot…" : 'Restoring notes…'),
    );
    if (outcome.status === 'aborted') {
      const text = abortedMessage(outcome.reason);
      notify(text, SUMMARY_NOTICE_MS);
      if (!this.isCurrent(gen)) return;
      this.begin('aborted');
      this.contentEl.createEl('p', { text: abortedText(outcome.reason), cls: 'ai-terminal-restore-error' });
      this.buttons([
        ['Back', () => this.showFiles()],
        ['Close', () => this.close()],
      ]);
      return;
    }
    notify(restoreSummary(outcome), SUMMARY_NOTICE_MS);
    if (!this.closed) this.close();
  }

  // ---------------------------------------------------------------- helpers

  /** Starts a new step: clears the content; async work for an earlier step is dropped. */
  private begin(step: RestoreStep): number {
    this.step = step;
    this.restoreButton = null;
    this.contentEl.empty();
    return ++this.generation;
  }

  private isCurrent(generation: number): boolean {
    return !this.closed && generation === this.generation;
  }

  private buttons(specs: Array<[text: string, onClick: () => void, cls?: string]>): HTMLButtonElement[] {
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    return specs.map(([text, onClick, cls]) => {
      const b = row.createEl('button', { text, cls });
      b.addEventListener('click', onClick);
      return b;
    });
  }
}
