// IDE connection test helpers: a WebSocket client that speaks the Claude Code side of the protocol, and a fake
// selection source standing in for bridgeState.
import { WebSocket } from 'ws';
import type { BridgeChange, EditorSelectionSnapshot } from '../../src/bridge/state';
import type { SelectionSource } from '../../src/bridge/ideServer';
import type { Disposer } from '../../src/core/types';

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

export class IdeTestClient {
  readonly messages: RpcMessage[] = [];
  private nextId = 1;
  private waiters: Array<{ pred: (m: RpcMessage) => boolean; resolve: (m: RpcMessage) => void }> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RpcMessage;
      this.messages.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
  }

  /** Next message (already received or future) matching `pred` that has not been consumed by `since`. */
  next(pred: (m: RpcMessage) => boolean, timeoutMs = 2000, since = 0): Promise<RpcMessage> {
    const found = this.messages.slice(since).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  send(raw: string): void {
    this.ws.send(raw);
  }

  request(method: string, params?: unknown): Promise<RpcMessage> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return this.next((m) => m.id === id);
  }

  notify(method: string, params?: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** initialize + notifications/initialized + ide_connected, like Claude Code 2.1.292. */
  async handshake(protocolVersion = '2025-11-25'): Promise<RpcMessage> {
    const init = await this.request('initialize', { protocolVersion, capabilities: { roots: { listChanged: true }, elicitation: {} }, clientInfo: { name: 'claude-code', version: '2.1.292' } });
    this.notify('notifications/initialized');
    this.notify('ide_connected', { pid: process.pid });
    return init;
  }

  selections(): RpcMessage[] {
    return this.messages.filter((m) => m.method === 'selection_changed');
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

export type ConnectResult = { ok: true; client: IdeTestClient } | { ok: false; status?: number; error: string };

/** Opens a WebSocket like Claude Code (subprotocol `mcp`, token header). `token: null` sends no header. */
export function connect(port: number, token: string | null, opts: { protocols?: string[]; headerName?: string } = {}): Promise<ConnectResult> {
  const headers: Record<string, string> = { 'User-Agent': 'claude-code/test' };
  if (token !== null) headers[opts.headerName ?? 'X-Claude-Code-Ide-Authorization'] = token;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts.protocols ?? ['mcp'], { headers });
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ ok: true, client: new IdeTestClient(ws) }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
      ws.terminate();
    });
    ws.once('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

export function snapshot(over: Partial<EditorSelectionSnapshot> = {}): EditorSelectionSnapshot {
  return {
    path: 'Notes/X.md',
    absolutePath: '/vault/Notes/X.md',
    text: 'line 2\nline 3\nline 4\n',
    from: { line: 1, ch: 0 },
    to: { line: 4, ch: 0 },
    fromLine: 2,
    toLine: 4,
    isEmpty: false,
    ...over,
  };
}

/** Stand-in for bridgeState: `emit()` behaves like a debounced onChange firing. */
export class FakeSelectionSource implements SelectionSource {
  current: EditorSelectionSnapshot | null = null;
  private readonly listeners = new Set<(c: BridgeChange) => void>();

  currentSelection(): EditorSelectionSnapshot | null {
    return this.current;
  }

  onChange(fn: (c: BridgeChange) => void): Disposer {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  emit(snap: EditorSelectionSnapshot): void {
    this.current = snap;
    for (const fn of [...this.listeners]) fn({ path: snap.path, selection: snap });
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
