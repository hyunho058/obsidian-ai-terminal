// Bridge test helpers. Extends the shared obsidian mock locally (never edits tests/mocks/obsidian.ts):
// leaves know their root split (main / left / right sidebar), `openFile` records its calls, `revealLeaf` does not
// change the active leaf (like Obsidian 1.14), `getMostRecentLeaf` only considers the main area, and closing a leaf
// fires `layout-change`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App, Plugin } from 'obsidian';
import { TERMINAL_VIEW_TYPE } from '../../src/core/constants';
import { PluginRuntime } from '../../src/core/runtime';
import type { FeatureModule } from '../../src/core/types';
import { SettingsStore } from '../../src/settings';
import { createLogger, type LogSink } from '../../src/util/log';
import {
  App as MockApp,
  Editor,
  ItemView,
  MarkdownView,
  Plugin as MockPlugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
  createManifest,
  type ViewState,
} from '../mocks/obsidian';

type Side = 'main' | 'left' | 'right';

export interface OpenFileCall {
  leaf: TestLeaf;
  path: string;
  openState: { active?: boolean; eState?: Record<string, unknown> } | undefined;
}

export class TestLeaf extends WorkspaceLeaf {
  activeTime = 0;
  /** View state for a not-yet-loaded (deferred) tab. */
  deferredState: ViewState | null = null;

  getRoot(): unknown {
    const ws = this.app.workspace as unknown as TestWorkspaceExtras;
    return this.side === 'main' ? ws.rootSplit : this.side === 'left' ? ws.leftSplit : ws.rightSplit;
  }

  getViewState(): ViewState {
    if (this.deferredState) return this.deferredState;
    return { ...super.getViewState(), pinned: this.pinned };
  }

  async openFile(file: TFile, openState?: OpenFileCall['openState']): Promise<void> {
    (this.app as unknown as BridgeTestApp).openFileCalls.push({ leaf: this, path: file.path, openState });
    const view = new MarkdownView(this);
    view.file = file;
    view.navigation = true;
    view.editor = new Editor(this.app.vault.contents.get(file.path) ?? '');
    this.view = view;
    this.deferredState = null;
    if (openState?.active) this.app.workspace.setActiveLeaf(this);
    this.app.workspace.trigger('file-open', file);
  }

  detach(): void {
    super.detach();
    this.app.workspace.trigger('layout-change');
  }
}

class TerminalStubView extends ItemView {
  getViewType(): string {
    return TERMINAL_VIEW_TYPE;
  }
  getDisplayText(): string {
    return 'Claude Code';
  }
}

interface TestWorkspaceExtras {
  rootSplit: object;
  leftSplit: object;
  rightSplit: object;
  revealed: TestLeaf[];
}

export interface BridgeTestApp extends MockApp {
  openFileCalls: OpenFileCall[];
}

export interface BridgeEnv {
  app: BridgeTestApp;
  /** The app as the plugin code sees it. */
  obsidianApp: App;
  revealed: TestLeaf[];
  addNote(path: string, content?: string, side?: Side): { leaf: TestLeaf; view: MarkdownView; editor: Editor };
  addTerminal(side?: Side): TestLeaf;
  /** A tab whose view is not loaded yet (Obsidian 1.7+ deferred views). */
  addDeferredNote(path: string, content?: string): TestLeaf;
  focus(leaf: WorkspaceLeaf): void;
  /** Leaves created by `getLeaf('tab')`. */
  newTabs: TestLeaf[];
}

export function createBridgeEnv(vaultPath = '/vault'): BridgeEnv {
  const app = new MockApp(vaultPath) as BridgeTestApp;
  app.openFileCalls = [];
  const ws = app.workspace;
  const extras = ws as unknown as TestWorkspaceExtras;
  extras.rootSplit = { name: 'root' };
  extras.leftSplit = { name: 'left' };
  extras.rightSplit = { name: 'right' };
  extras.revealed = [];
  const newTabs: TestLeaf[] = [];
  let clock = 1;

  const addLeaf = (side: Side): TestLeaf => {
    const leaf = new TestLeaf(app, side);
    ws.leaves.push(leaf);
    return leaf;
  };
  ws.getLeaf = ((newLeaf?: unknown) => {
    const leaf = addLeaf('main');
    if (newLeaf === 'tab' || newLeaf === true) newTabs.push(leaf);
    return leaf;
  }) as typeof ws.getLeaf;
  ws.getMostRecentLeaf = () => {
    const main = ws.leaves.filter((l): l is TestLeaf => l instanceof TestLeaf && l.side === 'main');
    if (main.length === 0) return null;
    return main.reduce((best, l) => (l.activeTime > best.activeTime ? l : best), main[0]!);
  };
  ws.revealLeaf = async (leaf) => {
    extras.revealed.push(leaf as TestLeaf);
  };
  const origSetActive = ws.setActiveLeaf.bind(ws);
  ws.setActiveLeaf = (leaf, params) => {
    if (leaf instanceof TestLeaf) leaf.activeTime = clock++;
    origSetActive(leaf, params);
  };

  const ensureFile = (path: string, content: string): TFile => {
    const existing = app.vault.getFileByPath(path);
    if (existing) return existing;
    return app.vault.addFile(path, content);
  };

  return {
    app,
    obsidianApp: app as unknown as App,
    revealed: extras.revealed,
    newTabs,
    addNote(path, content = '', side = 'main') {
      const file = ensureFile(path, content);
      const leaf = addLeaf(side);
      const view = new MarkdownView(leaf);
      view.file = file;
      view.navigation = true;
      view.editor = new Editor(app.vault.contents.get(path) ?? content);
      leaf.view = view;
      return { leaf, view, editor: view.editor };
    },
    addTerminal(side = 'right') {
      const leaf = addLeaf(side);
      leaf.view = new TerminalStubView(leaf);
      return leaf;
    },
    addDeferredNote(path, content = '') {
      ensureFile(path, content);
      const leaf = addLeaf('main');
      leaf.deferredState = { type: 'markdown', state: { file: path } };
      return leaf;
    },
    focus(leaf) {
      ws.setActiveLeaf(leaf);
    },
  };
}

/** Adds a folder entry to the mock vault (the mock only tracks files). */
export function addFolder(env: BridgeEnv, path: string): void {
  const folder = new TFolder(path);
  (env.app.vault as unknown as { files: Map<string, unknown> }).files.set(path, folder);
}

export function silentSink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]): void => void lines.push(a.join(' '));
  return { lines, debug: push, info: push, warn: push, error: push };
}

class TestPlugin extends MockPlugin {
  editorExtensions: unknown[] = [];
  registerEditorExtension(ext: unknown): void {
    this.editorExtensions.push(ext);
  }
}

/** A PluginRuntime over the bridge test app with the given modules (settings from `data`). */
export async function startRuntime(env: BridgeEnv, modules: FeatureModule[], data: unknown = null) {
  const plugin = new TestPlugin(env.app, createManifest());
  const store = new SettingsStore((d) => plugin.saveData(d));
  store.load(data);
  const out = silentSink();
  const runtime = new PluginRuntime({
    app: env.obsidianApp,
    plugin: plugin as unknown as Plugin,
    settingsStore: store,
    vaultPath: '/vault',
    pluginDir: mkdtempSync(join(tmpdir(), 'plugindir-')),
    log: createLogger(undefined, out),
  });
  await runtime.start(modules);
  await runtime.ctx.ready;
  return { runtime, ctx: runtime.ctx, plugin, store, out };
}
