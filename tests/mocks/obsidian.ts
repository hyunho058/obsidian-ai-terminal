// Minimal runtime stand-in for the `obsidian` module (aliased in vitest.config.ts). Only what the plugin's
// tests need; later tasks extend it. Tests that use mock-only helpers (Notice.shown, createMockApp …) import
// this file directly — it is the same module instance as `obsidian` at runtime.

// ---------------------------------------------------------------- DOM helpers

/** Tiny element used when no DOM environment is loaded (vitest `node` environment). */
export class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  classList = new Set<string>();
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  value = '';
  private text = '';
  private listeners = new Map<string, Set<(ev: any) => void>>();

  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
  }

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(t: string) {
    this.children = [];
    this.text = t;
  }
  get className(): string {
    return [...this.classList].join(' ');
  }

  empty(): void {
    this.children = [];
    this.text = '';
  }
  setText(t: string): void {
    this.textContent = t;
  }
  createEl(tag: string, o?: DomElementInfo | string, cb?: (el: FakeElement) => void): FakeElement {
    const el = new FakeElement(tag);
    applyInfo(el, o);
    this.appendChild(el);
    cb?.(el);
    return el;
  }
  createDiv(o?: DomElementInfo | string, cb?: (el: FakeElement) => void): FakeElement {
    return this.createEl('div', o, cb);
  }
  createSpan(o?: DomElementInfo | string, cb?: (el: FakeElement) => void): FakeElement {
    return this.createEl('span', o, cb);
  }
  appendChild<T extends FakeElement>(el: T): T {
    el.parent?.removeChild(el);
    el.parent = this;
    this.children.push(el);
    return el;
  }
  removeChild(el: FakeElement): void {
    this.children = this.children.filter((c) => c !== el);
    el.parent = null;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  detach(): void {
    this.remove();
  }
  addClass(...cls: string[]): void {
    for (const c of cls) this.classList.add(c);
  }
  addClasses(cls: string[]): void {
    this.addClass(...cls);
  }
  removeClass(...cls: string[]): void {
    for (const c of cls) this.classList.delete(c);
  }
  toggleClass(cls: string, value: boolean): void {
    if (value) this.classList.add(cls);
    else this.classList.delete(cls);
  }
  hasClass(cls: string): boolean {
    return this.classList.has(cls);
  }
  setAttr(name: string, value: string | number | boolean | null): void {
    if (value === null) delete this.attrs[name];
    else this.attrs[name] = String(value);
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttr(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  getAttribute(name: string): string | null {
    return this.getAttr(name);
  }
  show(): void {
    delete this.style.display;
  }
  hide(): void {
    this.style.display = 'none';
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** Test helper: invoke listeners of `type`. */
  dispatch(type: string, ev: any = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  focus(): void {}
  blur(): void {}
  /** Test helper: depth-first search. */
  findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const c of el.children) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

export interface DomElementInfo {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  value?: string;
  type?: string;
  placeholder?: string;
}

function applyInfo(el: any, o?: DomElementInfo | string): void {
  if (!o) return;
  const info: DomElementInfo = typeof o === 'string' ? { cls: o } : o;
  if (info.cls) el.addClass(...(Array.isArray(info.cls) ? info.cls : info.cls.split(' ').filter(Boolean)));
  if (info.text !== undefined) el.setText(info.text);
  if (info.attr) for (const [k, v] of Object.entries(info.attr)) el.setAttr(k, v);
  if (info.title !== undefined) el.setAttr('title', info.title);
  if (info.value !== undefined) el.value = info.value;
  if (info.type !== undefined) el.setAttr('type', info.type);
  if (info.placeholder !== undefined) el.setAttr('placeholder', info.placeholder);
}

/** Adds Obsidian's HTMLElement helpers (createEl, empty, addClass …) when a DOM environment is present. */
export function installDomShims(): void {
  const P = (globalThis as any).HTMLElement?.prototype;
  if (!P || P.createEl) return;
  const doc = (globalThis as any).document;
  P.createEl = function (tag: string, o?: DomElementInfo | string, cb?: (el: any) => void) {
    const el = doc.createElement(tag);
    applyInfo(el, o);
    this.appendChild(el);
    cb?.(el);
    return el;
  };
  P.createDiv = function (o?: DomElementInfo | string, cb?: (el: any) => void) {
    return this.createEl('div', o, cb);
  };
  P.createSpan = function (o?: DomElementInfo | string, cb?: (el: any) => void) {
    return this.createEl('span', o, cb);
  };
  P.empty = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  P.setText = function (t: string) {
    this.textContent = t;
  };
  P.addClass = function (...c: string[]) {
    this.classList.add(...c);
  };
  P.addClasses = function (c: string[]) {
    this.classList.add(...c);
  };
  P.removeClass = function (...c: string[]) {
    this.classList.remove(...c);
  };
  P.toggleClass = function (c: string, v: boolean) {
    this.classList.toggle(c, v);
  };
  P.hasClass = function (c: string) {
    return this.classList.contains(c);
  };
  P.setAttr = function (k: string, v: string | number | boolean | null) {
    if (v === null) this.removeAttribute(k);
    else this.setAttribute(k, String(v));
  };
  P.getAttr = function (k: string) {
    return this.getAttribute(k);
  };
  P.detach = function () {
    this.remove();
  };
  P.show = function () {
    this.style.display = '';
  };
  P.hide = function () {
    this.style.display = 'none';
  };
  P.setCssProps = function (props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
}

installDomShims();

/** A real element when a DOM environment is loaded, else a FakeElement. */
export function createElement(tag = 'div'): any {
  const doc = (globalThis as any).document;
  return doc ? doc.createElement(tag) : new FakeElement(tag);
}

// ---------------------------------------------------------------- events / components

export interface EventRef {
  e: Events;
  name: string;
  fn: (...data: any[]) => any;
}

export class Events {
  private handlers = new Map<string, Set<(...data: any[]) => any>>();

  on(name: string, callback: (...data: any[]) => any, ctx?: any): EventRef {
    const fn = ctx ? callback.bind(ctx) : callback;
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn);
    return { e: this, name, fn };
  }
  off(name: string, callback: (...data: any[]) => any): void {
    this.handlers.get(name)?.delete(callback);
  }
  offref(ref: EventRef): void {
    this.handlers.get(ref.name)?.delete(ref.fn);
  }
  trigger(name: string, ...data: any[]): void {
    for (const fn of [...(this.handlers.get(name) ?? [])]) fn(...data);
  }
  tryTrigger(ref: EventRef, args: any[]): void {
    try {
      ref.fn(...args);
    } catch (e) {
      console.error(e);
    }
  }
}

export class Component {
  _loaded = false;
  private _children: Component[] = [];
  private _cleanups: Array<() => any> = [];

  load(): void {
    if (this._loaded) return;
    this._loaded = true;
    this.onload();
    for (const c of this._children) c.load();
  }
  onload(): void {}
  unload(): void {
    if (!this._loaded) return;
    this._loaded = false;
    for (const c of this._children.splice(0)) c.unload();
    for (const fn of this._cleanups.splice(0)) fn();
    this.onunload();
  }
  onunload(): void {}
  addChild<T extends Component>(c: T): T {
    this._children.push(c);
    if (this._loaded) c.load();
    return c;
  }
  removeChild<T extends Component>(c: T): T {
    this._children = this._children.filter((x) => x !== c);
    c.unload();
    return c;
  }
  register(cb: () => any): void {
    this._cleanups.push(cb);
  }
  registerEvent(ref: EventRef): void {
    this.register(() => ref.e.offref(ref));
  }
  registerDomEvent(el: any, type: string, cb: (ev: any) => any, options?: any): void {
    el.addEventListener(type, cb, options);
    this.register(() => el.removeEventListener(type, cb, options));
  }
  registerInterval(id: number): number {
    this.register(() => clearInterval(id));
    return id;
  }
}

// ---------------------------------------------------------------- vault / files

export class FileSystemAdapter {
  constructor(private basePath: string) {}
  getBasePath(): string {
    return this.basePath;
  }
  getName(): string {
    return this.basePath.split('/').filter(Boolean).pop() ?? '';
  }
  getFullPath(normalizedPath: string): string {
    return `${this.basePath}/${normalizedPath}`;
  }
}

export abstract class TAbstractFile {
  vault!: Vault;
  path: string;
  name: string;
  parent: TFolder | null = null;
  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() ?? path;
  }
}

export class TFile extends TAbstractFile {
  stat = { ctime: 0, mtime: 0, size: 0 };
  get basename(): string {
    const i = this.name.lastIndexOf('.');
    return i > 0 ? this.name.slice(0, i) : this.name;
  }
  get extension(): string {
    const i = this.name.lastIndexOf('.');
    return i > 0 ? this.name.slice(i + 1) : '';
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === '/' || this.path === '';
  }
}

export class Vault extends Events {
  configDir = '.obsidian';
  readonly contents = new Map<string, string>();
  private files = new Map<string, TAbstractFile>();

  constructor(public adapter: FileSystemAdapter | object) {
    super();
  }
  getName(): string {
    return this.adapter instanceof FileSystemAdapter ? this.adapter.getName() : 'vault';
  }
  /** Test helper: adds a file with content. */
  addFile(path: string, content = ''): TFile {
    const f = new TFile(path);
    f.vault = this;
    this.files.set(path, f);
    this.contents.set(path, content);
    return f;
  }
  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(path) ?? null;
  }
  getFileByPath(path: string): TFile | null {
    const f = this.files.get(path);
    return f instanceof TFile ? f : null;
  }
  getFiles(): TFile[] {
    return [...this.files.values()].filter((f): f is TFile => f instanceof TFile);
  }
  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === 'md');
  }
  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.files.values()];
  }
  async read(file: TFile): Promise<string> {
    return this.contents.get(file.path) ?? '';
  }
  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }
}

export class MetadataCache extends Events {
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  getFileCache(_file: TFile): any {
    return null;
  }
  getFirstLinkpathDest(_linkpath: string, _sourcePath: string): TFile | null {
    return null;
  }
}

// ---------------------------------------------------------------- editor / views / workspace

export interface EditorPosition {
  line: number;
  ch: number;
}

/** Line-based editor stand-in (MarkdownView.editor). */
export class Editor {
  private lines: string[];
  anchor: EditorPosition = { line: 0, ch: 0 };
  head: EditorPosition = { line: 0, ch: 0 };

  constructor(text = '') {
    this.lines = text.split('\n');
  }
  getValue(): string {
    return this.lines.join('\n');
  }
  setValue(text: string): void {
    this.lines = text.split('\n');
  }
  getLine(n: number): string {
    return this.lines[n] ?? '';
  }
  lineCount(): number {
    return this.lines.length;
  }
  getCursor(which: 'from' | 'to' | 'head' | 'anchor' = 'head'): EditorPosition {
    const [from, to] = this.ordered();
    if (which === 'from') return { ...from };
    if (which === 'to') return { ...to };
    return { ...(which === 'anchor' ? this.anchor : this.head) };
  }
  setCursor(pos: EditorPosition | number, ch = 0): void {
    const p = typeof pos === 'number' ? { line: pos, ch } : pos;
    this.anchor = { ...p };
    this.head = { ...p };
  }
  setSelection(anchor: EditorPosition, head: EditorPosition = anchor): void {
    this.anchor = { ...anchor };
    this.head = { ...head };
  }
  listSelections(): Array<{ anchor: EditorPosition; head: EditorPosition }> {
    return [{ anchor: { ...this.anchor }, head: { ...this.head } }];
  }
  somethingSelected(): boolean {
    return this.anchor.line !== this.head.line || this.anchor.ch !== this.head.ch;
  }
  getSelection(): string {
    return this.getRange(...this.ordered());
  }
  getRange(from: EditorPosition, to: EditorPosition): string {
    if (from.line === to.line) return this.getLine(from.line).slice(from.ch, to.ch);
    const parts = [this.getLine(from.line).slice(from.ch)];
    for (let l = from.line + 1; l < to.line; l++) parts.push(this.getLine(l));
    parts.push(this.getLine(to.line).slice(0, to.ch));
    return parts.join('\n');
  }
  replaceSelection(text: string): void {
    const [from, to] = this.ordered();
    const value = this.getValue();
    const offset = (p: EditorPosition): number => this.lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.ch;
    this.setValue(value.slice(0, offset(from)) + text + value.slice(offset(to)));
  }
  scrollIntoView(_range: { from: EditorPosition; to: EditorPosition }, _center?: boolean): void {}
  focus(): void {}
  private ordered(): [EditorPosition, EditorPosition] {
    const a = this.anchor;
    const h = this.head;
    return a.line < h.line || (a.line === h.line && a.ch <= h.ch) ? [a, h] : [h, a];
  }
}

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
  pinned?: boolean;
}

export type ViewCreator = (leaf: WorkspaceLeaf) => View;

export abstract class View extends Component {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: any;
  icon = '';
  navigation = false;
  scope: Scope | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = createElement('div');
  }
  abstract getViewType(): string;
  abstract getDisplayText(): string;
  getIcon(): string {
    return this.icon;
  }
  getState(): Record<string, unknown> {
    return {};
  }
  async setState(_state: unknown, _result: unknown): Promise<void> {}
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
  onResize(): void {}
  getEphemeralState(): Record<string, unknown> {
    return {};
  }
  setEphemeralState(_state: unknown): void {}
}

export abstract class ItemView extends View {
  contentEl: any;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
  }
  addAction(_icon: string, title: string, callback: (evt: MouseEvent) => any): any {
    const el = this.containerEl.createDiv({ cls: 'view-action', attr: { 'aria-label': title } });
    el.addEventListener('click', callback);
    return el;
  }
}

export class FileView extends ItemView {
  file: TFile | null = null;
  getViewType(): string {
    return 'file';
  }
  getDisplayText(): string {
    return this.file?.basename ?? '';
  }
}

export class MarkdownView extends FileView {
  editor: Editor = new Editor();
  getViewType(): string {
    return 'markdown';
  }
  getMode(): 'source' | 'preview' {
    return 'source';
  }
}

export class WorkspaceLeaf extends Events {
  view: View | null = null;
  detached = false;
  pinned = false;
  /** Test helper: which area the leaf lives in. */
  side: 'main' | 'left' | 'right';

  constructor(
    public app: App,
    side: 'main' | 'left' | 'right' = 'main',
  ) {
    super();
    this.side = side;
  }
  getViewState(): ViewState {
    return { type: this.view?.getViewType() ?? 'empty', state: this.view?.getState() ?? {} };
  }
  async setViewState(state: ViewState, result?: unknown): Promise<void> {
    const creator = this.app.viewCreators.get(state.type);
    if (this.view) await this.view.onClose();
    if (!creator) {
      this.view = null;
      return;
    }
    this.view = creator(this);
    this.view.load();
    await this.view.onOpen();
    await this.view.setState(state.state ?? {}, result ?? {});
  }
  async open(view: View): Promise<View> {
    this.view = view;
    await view.onOpen();
    return view;
  }
  getDisplayText(): string {
    return this.view?.getDisplayText() ?? '';
  }
  setPinned(pinned: boolean): void {
    this.pinned = pinned;
  }
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    const view = this.view;
    if (view) {
      void view.onClose();
      view.unload();
    }
    this.app.workspace.removeLeaf(this);
  }
}

export class Workspace extends Events {
  leaves: WorkspaceLeaf[] = [];
  activeLeaf: WorkspaceLeaf | null = null;
  layoutReady = true;
  /** Test inspection: calls to openLinkText. */
  openedLinks: Array<{ linktext: string; sourcePath: string; newLeaf?: unknown; state?: unknown }> = [];
  /** Test inspection: calls to requestSaveLayout. */
  layoutSaveRequests = 0;
  requestSaveLayout: (() => void) & { cancel(): void; run(): void } = Object.assign(
    () => {
      this.layoutSaveRequests++;
    },
    { cancel: () => {}, run: () => {} },
  );
  private layoutCallbacks: Array<() => any> = [];

  constructor(public app: App) {
    super();
  }
  onLayoutReady(cb: () => any): void {
    if (this.layoutReady) queueMicrotask(cb);
    else this.layoutCallbacks.push(cb);
  }
  /** Test helper. */
  fireLayoutReady(): void {
    this.layoutReady = true;
    for (const cb of this.layoutCallbacks.splice(0)) cb();
  }
  private addLeaf(side: 'main' | 'left' | 'right'): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this.app, side);
    this.leaves.push(leaf);
    return leaf;
  }
  getLeaf(_newLeaf?: boolean | 'tab' | 'split' | 'window', _direction?: 'vertical' | 'horizontal'): WorkspaceLeaf {
    return this.addLeaf('main');
  }
  getRightLeaf(_split: boolean): WorkspaceLeaf {
    return this.addLeaf('right');
  }
  getLeftLeaf(_split: boolean): WorkspaceLeaf {
    return this.addLeaf('left');
  }
  createLeafBySplit(_leaf: WorkspaceLeaf, _direction?: 'vertical' | 'horizontal', _before?: boolean): WorkspaceLeaf {
    return this.addLeaf('main');
  }
  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.leaves.filter((l) => l.view?.getViewType() === type);
  }
  iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => any): void {
    for (const l of [...this.leaves]) cb(l);
  }
  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.setActiveLeaf(leaf);
  }
  setActiveLeaf(leaf: WorkspaceLeaf, _params?: { focus?: boolean }): void {
    this.activeLeaf = leaf;
    this.trigger('active-leaf-change', leaf);
  }
  getActiveViewOfType<T extends View>(type: abstract new (...args: any[]) => T): T | null {
    const v = this.activeLeaf?.view;
    return v instanceof type ? (v as T) : null;
  }
  getActiveFile(): TFile | null {
    const v = this.activeLeaf?.view;
    return v instanceof FileView ? v.file : null;
  }
  get activeEditor(): { editor?: Editor; file: TFile | null } | null {
    const v = this.activeLeaf?.view;
    return v instanceof MarkdownView ? { editor: v.editor, file: v.file } : null;
  }
  async openLinkText(linktext: string, sourcePath: string, newLeaf?: unknown, state?: unknown): Promise<void> {
    this.openedLinks.push({ linktext, sourcePath, newLeaf, state });
  }
  detachLeavesOfType(type: string): void {
    for (const l of this.getLeavesOfType(type)) l.detach();
  }
  removeLeaf(leaf: WorkspaceLeaf): void {
    this.leaves = this.leaves.filter((l) => l !== leaf);
    if (this.activeLeaf === leaf) this.activeLeaf = null;
  }
  getMostRecentLeaf(): WorkspaceLeaf | null {
    return this.activeLeaf ?? this.leaves[this.leaves.length - 1] ?? null;
  }
}

export class App {
  vault: Vault;
  workspace: Workspace;
  metadataCache = new MetadataCache();
  /** Mock-only: view creators registered through Plugin.registerView. */
  viewCreators = new Map<string, ViewCreator>();

  constructor(vaultPath = '/tmp/mock-vault') {
    this.vault = new Vault(new FileSystemAdapter(vaultPath));
    this.workspace = new Workspace(this);
  }
}

export function createMockApp(vaultPath = '/tmp/mock-vault'): App {
  return new App(vaultPath);
}

// ---------------------------------------------------------------- plugin

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  dir?: string;
  isDesktopOnly?: boolean;
}

export interface Command {
  id: string;
  name: string;
  icon?: string;
  callback?: () => any;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: Editor, ctx: any) => any;
  hotkeys?: Array<{ modifiers: string[]; key: string }>;
}

export function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'ai-terminal',
    name: 'AI Terminal',
    version: '0.1.0',
    minAppVersion: '1.13.0',
    description: 'test',
    author: 'test',
    isDesktopOnly: true,
    ...overrides,
  };
}

export abstract class Plugin extends Component {
  app: App;
  manifest: PluginManifest;
  settings?: unknown;
  /** Mock inspection. */
  commands: Command[] = [];
  ribbonIcons: Array<{ icon: string; title: string; callback: (evt: MouseEvent) => any; el: any }> = [];
  settingTabs: PluginSettingTab[] = [];
  /** Mock persistence (data.json). */
  data: unknown = null;

  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  async loadData(): Promise<any> {
    return this.data === null ? null : structuredClone(this.data);
  }
  async saveData(data: any): Promise<void> {
    this.data = structuredClone(data);
  }
  addCommand(command: Command): Command {
    const cmd = { ...command, id: `${this.manifest.id}:${command.id}` };
    this.commands.push(cmd);
    return cmd;
  }
  removeCommand(id: string): void {
    this.commands = this.commands.filter((c) => c.id !== `${this.manifest.id}:${id}`);
  }
  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): any {
    const el = createElement('div');
    this.ribbonIcons.push({ icon, title, callback, el });
    return el;
  }
  addStatusBarItem(): any {
    return createElement('div');
  }
  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }
  registerView(type: string, creator: ViewCreator): void {
    this.app.viewCreators.set(type, creator);
    this.register(() => this.app.viewCreators.delete(type));
  }
  registerExtensions(_ext: string[], _viewType: string): void {}
  registerObsidianProtocolHandler(_action: string, _handler: (params: any) => any): void {}
  registerEditorExtension(_ext: unknown): void {}
  registerMarkdownPostProcessor(pp: any): any {
    return pp;
  }
}

// ---------------------------------------------------------------- UI

export class Notice {
  /** Mock inspection: every Notice created. */
  static shown: Notice[] = [];
  static clear(): void {
    Notice.shown = [];
  }
  message: string;
  hidden = false;
  noticeEl: any = createElement('div');
  messageEl: any = createElement('div');

  constructor(
    message: string | DocumentFragment,
    public duration?: number,
  ) {
    this.message = String(message);
    Notice.shown.push(this);
  }
  setMessage(message: string | DocumentFragment): this {
    this.message = String(message);
    return this;
  }
  hide(): void {
    this.hidden = true;
  }
}

export class Scope {
  keys: Array<{ modifiers: string[] | null; key: string | null; func: (evt: KeyboardEvent, ctx: any) => any }> = [];
  constructor(public parent?: Scope) {}
  register(modifiers: string[] | null, key: string | null, func: (evt: KeyboardEvent, ctx: any) => any): any {
    const h = { modifiers, key, func };
    this.keys.push(h);
    return h;
  }
  unregister(handler: any): void {
    this.keys = this.keys.filter((k) => k !== handler);
  }
}

export class Modal {
  /** Mock inspection: currently open modals. */
  static open: Modal[] = [];
  app: App;
  scope = new Scope();
  containerEl: any = createElement('div');
  modalEl: any;
  titleEl: any;
  contentEl: any;
  isOpen = false;
  shouldRestoreSelection = false;

  constructor(app: App) {
    this.app = app;
    this.modalEl = this.containerEl.createDiv({ cls: 'modal' });
    this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' });
    this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
  }
  open(): void {
    this.isOpen = true;
    Modal.open.push(this);
    this.onOpen();
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    Modal.open = Modal.open.filter((m) => m !== this);
    this.onClose();
  }
  onOpen(): void | Promise<void> {}
  onClose(): void {}
  setTitle(title: string): this {
    this.titleEl.setText(title);
    return this;
  }
  setContent(content: string): this {
    this.contentEl.setText(content);
    return this;
  }
}

export class MenuItem {
  title = '';
  icon = '';
  section = '';
  callback?: (evt: MouseEvent | KeyboardEvent) => any;
  setTitle(t: string | DocumentFragment): this {
    this.title = String(t);
    return this;
  }
  setIcon(i: string | null): this {
    this.icon = i ?? '';
    return this;
  }
  setSection(s: string): this {
    this.section = s;
    return this;
  }
  setChecked(_c: boolean | null): this {
    return this;
  }
  onClick(cb: (evt: MouseEvent | KeyboardEvent) => any): this {
    this.callback = cb;
    return this;
  }
  /** Test helper. */
  click(): void {
    this.callback?.({} as MouseEvent);
  }
}

export class Menu extends Component {
  /** Mock inspection: menus that were shown. */
  static shown: Menu[] = [];
  items: MenuItem[] = [];
  addItem(cb: (item: MenuItem) => any): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_evt: MouseEvent): this {
    Menu.shown.push(this);
    return this;
  }
  showAtPosition(_pos: { x: number; y: number }): this {
    Menu.shown.push(this);
    return this;
  }
  hide(): this {
    return this;
  }
  onHide(_cb: () => any): void {}
}

// ---------------------------------------------------------------- settings

export abstract class SettingTab {
  app: App;
  containerEl: any = createElement('div');
  constructor(app: App) {
    this.app = app;
  }
  /** Like Obsidian 1.13: the default display() renders getSettingDefinitions() (group headings + `render` rows). */
  getSettingDefinitions(): any[] {
    return [];
  }
  display(): void {
    this.containerEl.empty();
    const renderItem = (item: any): void => {
      if (item.type === 'group' || item.type === 'list') {
        if (item.heading) new Setting(this.containerEl).setName(item.heading).setHeading();
        for (const child of item.items ?? []) renderItem(child);
        return;
      }
      const setting = new Setting(this.containerEl);
      if (item.render) item.render(setting, undefined);
      else {
        setting.setName(item.name);
        if (item.desc) setting.setDesc(item.desc);
      }
    };
    for (const item of this.getSettingDefinitions()) renderItem(item);
  }
  hide(): void {}
}

export abstract class PluginSettingTab extends SettingTab {
  plugin: Plugin;
  constructor(app: App, plugin: Plugin) {
    super(app);
    this.plugin = plugin;
  }
}

export abstract class BaseComponent {
  disabled = false;
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  then(cb: (c: this) => any): this {
    cb(this);
    return this;
  }
}

export abstract class ValueComponent<T> extends BaseComponent {
  protected value!: T;
  protected changeHandler?: (value: T) => any;
  getValue(): T {
    return this.value;
  }
  setValue(value: T): this {
    this.value = value;
    return this;
  }
  onChange(cb: (value: T) => any): this {
    this.changeHandler = cb;
    return this;
  }
  /** Test helper: what a user edit does — set the value and fire onChange. */
  simulateChange(value: T): unknown {
    this.value = value;
    return this.changeHandler?.(value);
  }
}

export class TextComponent extends ValueComponent<string> {
  inputEl: any = createElement('input');
  placeholder = '';
  constructor(public containerEl?: any) {
    super();
    this.value = '';
  }
  setPlaceholder(p: string): this {
    this.placeholder = p;
    return this;
  }
}

export class TextAreaComponent extends TextComponent {}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: any = createElement('div');
  constructor(public containerEl?: any) {
    super();
    this.value = false;
  }
  setTooltip(_t: string): this {
    return this;
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: any = createElement('select');
  options: Record<string, string> = {};
  constructor(public containerEl?: any) {
    super();
    this.value = '';
  }
  addOption(value: string, display: string): this {
    this.options[value] = display;
    return this;
  }
  addOptions(options: Record<string, string>): this {
    Object.assign(this.options, options);
    return this;
  }
}

export class SliderComponent extends ValueComponent<number> {
  sliderEl: any = createElement('input');
  min = 0;
  max = 100;
  step: number | 'any' = 1;
  constructor(public containerEl?: any) {
    super();
    this.value = 0;
  }
  setLimits(min: number | null, max: number | null, step: number | 'any'): this {
    if (min !== null) this.min = min;
    if (max !== null) this.max = max;
    this.step = step;
    return this;
  }
  setDynamicTooltip(): this {
    return this;
  }
  setInstant(_instant: boolean): this {
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: any = createElement('button');
  text = '';
  private clickHandler?: (evt: MouseEvent) => any;
  constructor(public containerEl?: any) {
    super();
  }
  setButtonText(t: string): this {
    this.text = t;
    return this;
  }
  setCta(): this {
    return this;
  }
  setWarning(): this {
    return this;
  }
  setDestructive(): this {
    return this;
  }
  setIcon(_i: string): this {
    return this;
  }
  setTooltip(_t: string): this {
    return this;
  }
  onClick(cb: (evt: MouseEvent) => any): this {
    this.clickHandler = cb;
    return this;
  }
  /** Test helper. */
  click(): unknown {
    return this.clickHandler?.({} as MouseEvent);
  }
}

export class ExtraButtonComponent extends ButtonComponent {}

export class Setting {
  /** Mock inspection: every Setting created (reset with `Setting.reset()`). */
  static created: Setting[] = [];
  static reset(): void {
    Setting.created = [];
  }
  settingEl: any;
  infoEl: any;
  nameEl: any;
  descEl: any;
  controlEl: any;
  name = '';
  desc = '';
  heading = false;
  components: BaseComponent[] = [];

  constructor(containerEl: any) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
    this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
    Setting.created.push(this);
  }
  setName(name: string | DocumentFragment): this {
    this.name = String(name);
    this.nameEl.setText(this.name);
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    this.desc = String(desc);
    this.descEl.setText(this.desc);
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.addClass(cls);
    return this;
  }
  setTooltip(_t: string): this {
    return this;
  }
  setHeading(): this {
    this.heading = true;
    return this;
  }
  setDisabled(_d: boolean): this {
    return this;
  }
  private add<C extends BaseComponent>(c: C, cb: (c: C) => any): this {
    this.components.push(c);
    cb(c);
    return this;
  }
  addText(cb: (c: TextComponent) => any): this {
    return this.add(new TextComponent(this.controlEl), cb);
  }
  addTextArea(cb: (c: TextAreaComponent) => any): this {
    return this.add(new TextAreaComponent(this.controlEl), cb);
  }
  addToggle(cb: (c: ToggleComponent) => any): this {
    return this.add(new ToggleComponent(this.controlEl), cb);
  }
  addDropdown(cb: (c: DropdownComponent) => any): this {
    return this.add(new DropdownComponent(this.controlEl), cb);
  }
  addSlider(cb: (c: SliderComponent) => any): this {
    return this.add(new SliderComponent(this.controlEl), cb);
  }
  addButton(cb: (c: ButtonComponent) => any): this {
    return this.add(new ButtonComponent(this.controlEl), cb);
  }
  addExtraButton(cb: (c: ExtraButtonComponent) => any): this {
    return this.add(new ExtraButtonComponent(this.controlEl), cb);
  }
  then(cb: (s: this) => any): this {
    cb(this);
    return this;
  }
  clear(): this {
    this.components = [];
    return this;
  }
}

// ---------------------------------------------------------------- misc

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: true,
  isWin: false,
  isLinux: false,
  isSafari: false,
  resourcePathPrefix: 'app://local',
};

export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return p === '' ? '/' : p;
}

export function setIcon(_el: any, _icon: string): void {}
export function addIcon(_id: string, _svg: string): void {}

export interface Debouncer<T extends unknown[]> {
  (...args: T): void;
  cancel(): Debouncer<T>;
  run(): void;
}

export function debounce<T extends unknown[]>(cb: (...args: T) => any, timeout = 0, resetTimer = false): Debouncer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: T | null = null;
  const fire = (): void => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) cb(...args);
  };
  const fn = ((...args: T) => {
    lastArgs = args;
    if (timer && resetTimer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!timer) timer = setTimeout(fire, timeout);
  }) as Debouncer<T>;
  fn.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    return fn;
  };
  fn.run = () => {
    if (timer) clearTimeout(timer);
    fire();
  };
  return fn;
}
