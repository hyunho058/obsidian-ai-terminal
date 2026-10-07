import { EditorView, type ViewUpdate } from '@codemirror/view';
import { MarkdownView, TFile, type App, type EditorPosition, type EventRef, type WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { TERMINAL_VIEW_TYPE, TypedEmitter, type Disposer } from '../core';
import type { Logger } from '../util/log';
import { BridgeError, pathCandidates, toVaultPath } from './paths';

/** Selection changes are reported this long after the selection stops changing (D27a). */
export const SELECTION_DEBOUNCE_MS = 300;

/** 0-based position as Obsidian's `Editor` reports it. */
export interface NotePosition {
  line: number;
  ch: number;
}

/** The selection (or cursor) of the last focused note editor. */
export interface EditorSelectionSnapshot {
  /** Vault-relative path (D19). */
  path: string;
  /** Absolute file path (`<vault>/<path>`) — for the IDE protocol, which uses absolute paths. */
  absolutePath: string;
  /** Selected text; `''` when nothing is selected (cursor only). */
  text: string;
  /** Start / end of the main selection, 0-based, `from <= to` regardless of selection direction. */
  from: NotePosition;
  to: NotePosition;
  /** 1-based, inclusive. A selection ending at the start of a line does not count that line. */
  fromLine: number;
  toLine: number;
  isEmpty: boolean;
}

/** Payload of `bridgeState.onChange`. */
export interface BridgeChange {
  path: string;
  selection: EditorSelectionSnapshot;
}

export type ActiveNoteResult = { path: string; content: string; cursorLine: number } | { empty: true; reason: string };
export type SelectionResult = { path: string; text: string; fromLine: number; toLine: number } | { text: ''; path?: string; reason: string };
export interface OpenNoteEntry {
  path: string;
  active: boolean;
}
export interface NoteLinks {
  outgoing: string[];
  backlinks: string[];
}
export interface OpenNoteResult {
  opened: string;
  line?: number;
}

/**
 * The `bridgeState` service (D24): Obsidian state as seen by the bridge tools and the IDE connection.
 * "Active note" = the last focused note editor; focusing a terminal (or any non-note view) does not change it.
 */
export interface BridgeStateService {
  getActiveNote(): ActiveNoteResult;
  getSelection(): SelectionResult;
  listOpenNotes(): OpenNoteEntry[];
  /** Throws `BridgeError` for an invalid or missing path. */
  getLinks(path: string): NoteLinks;
  /**
   * Opens a note in the main editor area (never a sidebar), scrolled to the 1-based `line`, without taking keyboard
   * focus from the terminal. Throws `BridgeError` for an invalid or missing path.
   */
  openNote(path: string, line?: number): Promise<OpenNoteResult>;
  /** Selection of the last focused note editor right now (null if there is none). */
  currentSelection(): EditorSelectionSnapshot | null;
  /**
   * Fires (debounced `SELECTION_DEBOUNCE_MS`) when the last note editor's selection, cursor or file changes, or another
   * note editor is focused. Never fires because focus moved to a terminal or another non-note view, and never with
   * "no note".
   */
  onChange(listener: (change: BridgeChange) => void): Disposer;
}

declare module '../core/services' {
  interface ServiceMap {
    bridgeState: BridgeStateService;
  }
}

export interface BridgeStateOptions {
  app: App;
  vaultPath: string;
  log: Logger;
  debounceMs?: number;
}

const NO_NOTE_YET = 'No note has been focused in Obsidian yet — ask the user to click into a note.';
const NOTE_CLOSED = 'The note the user last focused has been closed — ask the user to click into a note.';

export class BridgeState implements BridgeStateService {
  private readonly app: App;
  private readonly vaultPath: string;
  private readonly log: Logger;
  private readonly debounceMs: number;
  private readonly events: TypedEmitter<{ change: BridgeChange }>;
  private readonly refs: EventRef[] = [];
  private lastLeaf: WorkspaceLeaf | null = null;
  /** True once some note editor was tracked (distinguishes "never focused" from "closed"). */
  private everTracked = false;
  private lastKey: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: BridgeStateOptions) {
    this.app = opts.app;
    this.vaultPath = opts.vaultPath;
    this.log = opts.log;
    this.debounceMs = opts.debounceMs ?? SELECTION_DEBOUNCE_MS;
    this.events = new TypedEmitter((m, e) => this.log.error(m, e));
  }

  /** Subscribes to workspace events; picks up the note that is active when the layout is ready. */
  start(): void {
    const ws = this.app.workspace;
    this.refs.push(ws.on('active-leaf-change', (leaf) => this.leafActivated(leaf)));
    this.refs.push(ws.on('file-open', () => this.schedule()));
    this.refs.push(ws.on('layout-change', () => this.forgetIfClosed()));
    ws.onLayoutReady(() => {
      if (this.disposed || this.lastLeaf) return;
      const view = ws.getActiveViewOfType(MarkdownView);
      if (view) this.leafActivated(view.leaf);
    });
  }

  /** CodeMirror 6 extension (register with `plugin.registerEditorExtension`): reports selection / edit activity. */
  editorExtension(): ReturnType<typeof EditorView.updateListener.of> {
    return EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.selectionSet || update.docChanged) this.editorActivity();
    });
  }

  /** Any note editor's selection or text changed (called by the editor extension). */
  editorActivity(): void {
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const ref of this.refs.splice(0)) this.app.workspace.offref(ref);
    this.events.clear();
    this.lastLeaf = null;
  }

  onChange(listener: (change: BridgeChange) => void): Disposer {
    return this.events.on('change', listener);
  }

  getActiveNote(): ActiveNoteResult {
    const view = this.lastView();
    if (!view?.file) return { empty: true, reason: this.emptyReason() };
    return { path: view.file.path, content: view.editor.getValue(), cursorLine: view.editor.getCursor('head').line + 1 };
  }

  getSelection(): SelectionResult {
    const snap = this.currentSelection();
    if (!snap) return { text: '', reason: this.emptyReason() };
    if (snap.isEmpty) return { text: '', path: snap.path, reason: `Nothing is selected in ${snap.path} (cursor on line ${snap.fromLine}).` };
    return { path: snap.path, text: snap.text, fromLine: snap.fromLine, toLine: snap.toLine };
  }

  listOpenNotes(): OpenNoteEntry[] {
    const activePath = this.lastView()?.file?.path;
    const seen = new Set<string>();
    const out: OpenNoteEntry[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const p = notePathOf(leaf);
      if (!p || seen.has(p)) return;
      seen.add(p);
      out.push({ path: p, active: p === activePath });
    });
    return out;
  }

  getLinks(input: string): NoteLinks {
    const file = this.findFile(input);
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    const outgoing = Object.keys(resolved[file.path] ?? {}).sort();
    const backlinks = Object.entries(resolved)
      .filter(([, targets]) => targets && Object.prototype.hasOwnProperty.call(targets, file.path))
      .map(([source]) => source)
      .sort();
    return { outgoing, backlinks };
  }

  async openNote(input: string, line?: number): Promise<OpenNoteResult> {
    if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
      throw new BridgeError(`line must be a whole number ≥ 1 (got ${String(line)}).`, 'invalid-argument');
    }
    const file = this.findFile(input);
    let target: number | undefined;
    if (line !== undefined && file.extension === 'md') {
      const lines = (await this.app.vault.cachedRead(file)).split('\n').length;
      target = Math.min(line, Math.max(lines, 1));
    }
    const leaf = this.mainAreaLeafFor(file);
    await leaf.openFile(file, { active: false, eState: target !== undefined ? { line: target - 1 } : {} });
    await this.app.workspace.revealLeaf(leaf);
    return target !== undefined ? { opened: file.path, line: target } : { opened: file.path };
  }

  currentSelection(): EditorSelectionSnapshot | null {
    const view = this.lastView();
    if (!view?.file) return null;
    const editor = view.editor;
    const from = pos(editor.getCursor('from'));
    const to = pos(editor.getCursor('to'));
    const text = editor.getRange(from, to);
    const isEmpty = from.line === to.line && from.ch === to.ch;
    const lastLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
    return {
      path: view.file.path,
      absolutePath: path.join(this.vaultPath, view.file.path),
      text,
      from,
      to,
      fromLine: from.line + 1,
      toLine: lastLine + 1,
      isEmpty,
    };
  }

  // ---------------------------------------------------------------- tracking

  private leafActivated(leaf: WorkspaceLeaf | null): void {
    if (this.disposed || !leaf || !(leaf.view instanceof MarkdownView)) return;
    this.lastLeaf = leaf;
    this.everTracked = true;
    this.schedule();
  }

  private forgetIfClosed(): void {
    if (this.lastLeaf && !this.isAttached(this.lastLeaf)) this.lastLeaf = null;
  }

  /** The last focused note editor if its leaf is still open and still shows a note. */
  private lastView(): MarkdownView | null {
    this.forgetIfClosed();
    const view = this.lastLeaf?.view;
    return view instanceof MarkdownView ? view : null;
  }

  private emptyReason(): string {
    return this.everTracked ? NOTE_CLOSED : NO_NOTE_YET;
  }

  private isAttached(leaf: WorkspaceLeaf): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((l) => {
      if (l === leaf) found = true;
    });
    return found;
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    if (this.disposed) return;
    let snap: EditorSelectionSnapshot | null;
    try {
      snap = this.currentSelection();
    } catch (err) {
      this.log.warn('could not read the note selection', err);
      return;
    }
    // No note (never focused / closed): stay silent — an empty selection is never pushed for that.
    if (!snap) return;
    const key = `${snap.path}\0${snap.from.line}:${snap.from.ch}-${snap.to.line}:${snap.to.ch}\0${snap.text}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.events.emit('change', { path: snap.path, selection: snap });
  }

  // ---------------------------------------------------------------- files / leaves

  private findFile(input: string): TFile {
    const rel = toVaultPath(input);
    for (const candidate of pathCandidates(rel)) {
      const f = this.app.vault.getAbstractFileByPath(candidate);
      if (f instanceof TFile) return f;
      if (f) throw new BridgeError(`Not a note: "${rel}" is a folder.`, 'not-found');
    }
    throw new BridgeError(`Note not found: "${rel}".`, 'not-found');
  }

  /**
   * Where `open_note` opens a file: a main-area leaf already showing it; else the most recently used main-area leaf
   * that can navigate (an unpinned note / empty tab — never a terminal); else a new tab in the main area.
   */
  private mainAreaLeafFor(file: TFile): WorkspaceLeaf {
    const ws = this.app.workspace;
    const leaves: WorkspaceLeaf[] = [];
    ws.iterateAllLeaves((leaf) => {
      leaves.push(leaf);
    });
    const existing = leaves.find((leaf) => !this.inSidebar(leaf) && notePathOf(leaf, true) === file.path);
    if (existing) return existing;
    const recent = ws.getMostRecentLeaf();
    if (recent && !this.inSidebar(recent) && canNavigate(recent)) return recent;
    return ws.getLeaf('tab');
  }

  private inSidebar(leaf: WorkspaceLeaf): boolean {
    const root = leaf.getRoot();
    return root === this.app.workspace.leftSplit || root === this.app.workspace.rightSplit;
  }
}

function pos(p: EditorPosition): NotePosition {
  return { line: p.line, ch: p.ch };
}

/** Vault path of the note a leaf shows (markdown only unless `anyFile`); also works for not-yet-loaded (deferred) tabs. */
function notePathOf(leaf: WorkspaceLeaf, anyFile = false): string | null {
  const view = leaf.view;
  if (view instanceof MarkdownView) return view.file?.path ?? null;
  const file = (view as { file?: unknown } | null)?.file;
  if (anyFile && file instanceof TFile) return file.path;
  const vs = leaf.getViewState();
  const stateFile = vs.state?.file;
  if ((vs.type === 'markdown' || anyFile) && typeof stateFile === 'string') return stateFile;
  return null;
}

function canNavigate(leaf: WorkspaceLeaf): boolean {
  const view = leaf.view;
  if (!view || view.getViewType() === TERMINAL_VIEW_TYPE) return false;
  return view.navigation === true && !leaf.getViewState().pinned;
}
