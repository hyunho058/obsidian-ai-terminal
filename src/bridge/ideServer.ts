import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'crypto';
import * as http from 'http';
import type { AddressInfo, Socket } from 'net';
import type { Duplex } from 'stream';
import { pathToFileURL } from 'url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Disposer } from '../core';
import { registerSecret, type Logger } from '../util/log';
import type { BridgeStateService, EditorSelectionSnapshot } from './state';

export const IDE_HOST = '127.0.0.1';
/** Header Claude Code sends with the lock file's `authToken` (verified with 2.1.292; Node lower-cases header names). */
export const IDE_AUTH_HEADER = 'x-claude-code-ide-authorization';
/** WebSocket subprotocol Claude Code asks for. */
export const IDE_SUBPROTOCOL = 'mcp';
/** `serverInfo.name`; Claude Code shows the lock file's `ideName` ("Obsidian") in `/ide` and the status line. */
export const IDE_SERVER_NAME = 'Obsidian';
/**
 * When a newly initialized client gets the current selection. Claude Code registers its `selection_changed` handler a
 * moment after the handshake — a notification sent right at `notifications/initialized` is dropped (verified), so the
 * current state is sent shortly after and once more later.
 */
export const SEED_DELAYS_MS: readonly number[] = [250, 1500];
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** JSON-RPC error codes used here. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;

/** `params` of the `selection_changed` notification (shape of the VS Code extension; Claude reads selection/text/filePath). */
export interface SelectionChangedParams {
  text: string;
  /** Absolute path (the IDE protocol uses absolute paths, D27a). */
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

/**
 * Claude Code counts `end.line - start.line + 1` lines (one less when `end.character` is 0) and shows
 * "⧉ N lines selected", or "⧉ In <file>" for an empty selection.
 */
export function selectionChangedParams(snap: EditorSelectionSnapshot): SelectionChangedParams {
  return {
    text: snap.text,
    filePath: snap.absolutePath,
    fileUrl: pathToFileURL(snap.absolutePath).href,
    selection: {
      start: { line: snap.from.line, character: snap.from.ch },
      end: { line: snap.to.line, character: snap.to.ch },
      isEmpty: snap.isEmpty,
    },
  };
}

export type SelectionSource = Pick<BridgeStateService, 'currentSelection' | 'onChange'>;

export interface IdeServerOptions {
  log: Logger;
  /** Selection source (`bridgeState`); null = no selection is ever pushed. */
  state: SelectionSource | null;
  /** Plugin version for `serverInfo`. */
  version?: string;
  /** Fixed auth token (tests); default `crypto.randomUUID()`. */
  token?: string;
  seedDelaysMs?: readonly number[];
}

type Phase = 'stopped' | 'starting' | 'running';

interface IdeClient {
  ws: WebSocket;
  initialized: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
}

type JsonRpcId = string | number;

/**
 * Claude Code IDE connection server (D27a): WebSocket on `127.0.0.1:<random port>` speaking minimal MCP JSON-RPC —
 * `initialize`, `notifications/initialized`, `ping`, `tools/list` → no tools, every tool call refused (no `openDiff`,
 * `close_tab`, `closeAllDiffTabs`, `getDiagnostics`, save / dirty-check), anything else → method not found — and pushes
 * `selection_changed` from `bridgeState`. Upgrades without the token header get 401 (R10.2).
 */
export class IdeServer {
  readonly token: string;
  private readonly tokenBuf: Buffer;
  private readonly unregisterSecret: () => void;
  private readonly log: Logger;
  private readonly seedDelays: readonly number[];
  private readonly clients = new Set<IdeClient>();
  private readonly sockets = new Set<Socket>();
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private phase: Phase = 'stopped';
  private startPromise: Promise<void> | null = null;
  private abortStart: (() => void) | null = null;
  private currentPort: number | null = null;
  /** Reused on restart when free, so sessions started earlier find the same port again. */
  private lastPort = 0;
  private unsubscribe: Disposer | null = null;

  constructor(private readonly opts: IdeServerOptions) {
    this.token = opts.token ?? randomUUID();
    this.tokenBuf = Buffer.from(this.token);
    this.unregisterSecret = registerSecret(this.token);
    this.log = opts.log;
    this.seedDelays = opts.seedDelaysMs ?? SEED_DELAYS_MS;
  }

  get port(): number | null {
    return this.currentPort;
  }

  isRunning(): boolean {
    return this.phase === 'running';
  }

  /** Initialized (handshake complete) clients. */
  clientCount(): number {
    let n = 0;
    for (const c of this.clients) if (c.initialized) n++;
    return n;
  }

  whenListening(): Promise<void> {
    if (this.phase === 'running') return Promise.resolve();
    if (this.phase === 'starting' && this.startPromise) return this.startPromise;
    return Promise.reject(new Error('The Claude Code IDE connection is not running (turned off in settings or stopped).'));
  }

  /** Starts listening (no-op while starting / running). */
  start(): Promise<void> {
    if (this.phase !== 'stopped' && this.startPromise) return this.startPromise;
    const server = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('WebSocket upgrade required');
      req.resume();
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
      handleProtocols: (protocols) => (protocols.has(IDE_SUBPROTOCOL) ? IDE_SUBPROTOCOL : false),
    });
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    server.on('upgrade', (req, socket, head) => this.upgrade(wss, req, socket, head));
    this.server = server;
    this.wss = wss;
    this.phase = 'starting';

    const listen = (port: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port, host: IDE_HOST, exclusive: true });
      });
    // stop() during listen(): Node then emits neither 'listening' nor 'error', so stop() rejects through this hook.
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('The Claude Code IDE connection was stopped while starting.'));
    });
    this.abortStart = abort;
    const listening = listen(this.lastPort).catch((err: NodeJS.ErrnoException) => {
      if (this.lastPort !== 0 && err.code === 'EADDRINUSE' && this.server === server) return listen(0);
      throw err;
    });
    const promise = Promise.race([listening, aborted])
      .finally(() => {
        if (this.abortStart === abort) this.abortStart = null;
      })
      .then(
        () => {
          if (this.server !== server) {
            server.close();
            throw new Error('The Claude Code IDE connection was stopped while starting.');
          }
          this.currentPort = (server.address() as AddressInfo).port;
          this.lastPort = this.currentPort;
          this.phase = 'running';
          server.on('error', (err) => this.log.error('IDE server error', err));
          this.unsubscribe = this.opts.state?.onChange((change) => this.broadcast(change.selection)) ?? null;
          this.log.info(`IDE connection listening on ws://${IDE_HOST}:${this.currentPort}`);
        },
        (err: unknown) => {
          if (this.server === server) this.reset();
          throw err;
        },
      );
    this.startPromise = promise;
    promise.catch(() => {});
    return promise;
  }

  /** Closes the port and drops every client — synchronous, so it completes during plugin unload. */
  stop(): void {
    const server = this.server;
    const wss = this.wss;
    if (!server) return;
    this.reset();
    this.abortStart?.();
    for (const client of this.clients) {
      for (const t of client.timers) clearTimeout(t);
      client.ws.terminate();
    }
    this.clients.clear();
    wss?.close();
    server.close();
    server.closeAllConnections?.();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.log.info('IDE connection stopped');
  }

  /** `stop()` and forget the token (plugin unload). */
  dispose(): void {
    this.stop();
    this.unregisterSecret();
  }

  private reset(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.server = null;
    this.wss = null;
    this.phase = 'stopped';
    this.startPromise = null;
    this.currentPort = null;
  }

  private authorized(req: http.IncomingMessage): boolean {
    const given = req.headers[IDE_AUTH_HEADER];
    if (typeof given !== 'string') return false;
    const buf = Buffer.from(given);
    return buf.length === this.tokenBuf.length && timingSafeEqual(buf, this.tokenBuf);
  }

  private upgrade(wss: WebSocketServer, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (wss !== this.wss) {
      socket.destroy();
      return;
    }
    if (!this.authorized(req)) {
      this.log.warn('IDE connection refused: missing or wrong auth token');
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 12\r\n\r\nUnauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  private accept(ws: WebSocket): void {
    if (!this.wss) {
      ws.terminate();
      return;
    }
    const client: IdeClient = { ws, initialized: false, timers: new Set() };
    this.clients.add(client);
    this.log.debug('IDE client connected');
    ws.on('message', (data: RawData) => this.onMessage(client, data));
    ws.on('error', (err) => this.log.debug('IDE client error:', err.message));
    ws.on('close', () => {
      for (const t of client.timers) clearTimeout(t);
      this.clients.delete(client);
      this.log.debug('IDE client disconnected');
    });
  }

  private onMessage(client: IdeClient, data: RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(rawText(data));
    } catch {
      this.send(client, { jsonrpc: '2.0', id: null, error: { code: RPC_PARSE_ERROR, message: 'Parse error: invalid JSON' } });
      return;
    }
    if (!isObject(msg)) {
      this.send(client, { jsonrpc: '2.0', id: null, error: { code: RPC_INVALID_REQUEST, message: 'Invalid request (batches are not supported)' } });
      return;
    }
    const { id, method } = msg;
    if (typeof method !== 'string') return; // a response to nothing we sent, or garbage
    if (id === undefined || id === null) {
      this.onNotification(client, method, msg.params);
      return;
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      this.send(client, { jsonrpc: '2.0', id: null, error: { code: RPC_INVALID_REQUEST, message: 'Invalid request id' } });
      return;
    }
    this.onRequest(client, id, method, msg.params);
  }

  private onRequest(client: IdeClient, id: JsonRpcId, method: string, params: unknown): void {
    const reply = (result: unknown): void => this.send(client, { jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): void => this.send(client, { jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const requested = isObject(params) ? params.protocolVersion : undefined;
        const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        reply({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: IDE_SERVER_NAME, version: this.opts.version ?? '0.0.0' } });
        return;
      }
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools: [] });
        return;
      case 'tools/call': {
        // D27a: no diff / tab / save / diagnostics tools — Claude Code keeps edits and permission prompts in the terminal.
        const name = isObject(params) && typeof params.name === 'string' ? params.name : '?';
        this.log.debug(`IDE tool call refused: ${name}`);
        fail(RPC_INVALID_PARAMS, `Unknown tool: ${name} (Obsidian offers no IDE tools)`);
        return;
      }
      default:
        fail(RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private onNotification(client: IdeClient, method: string, params: unknown): void {
    if (method === 'notifications/initialized') {
      if (client.initialized) return;
      client.initialized = true;
      for (const delay of this.seedDelays) {
        const timer = setTimeout(() => {
          client.timers.delete(timer);
          this.seed(client);
        }, delay);
        client.timers.add(timer);
      }
      return;
    }
    if (method === 'ide_connected') {
      const pid = isObject(params) ? params.pid : undefined;
      this.log.info(`Claude Code connected${typeof pid === 'number' ? ` (pid ${pid})` : ''}`);
    }
  }

  private seed(client: IdeClient): void {
    let snap: EditorSelectionSnapshot | null = null;
    try {
      snap = this.opts.state?.currentSelection() ?? null;
    } catch (err) {
      this.log.warn('could not read the note selection', err);
    }
    if (snap) this.notifySelection(client, snap);
  }

  private broadcast(snap: EditorSelectionSnapshot): void {
    for (const client of this.clients) if (client.initialized) this.notifySelection(client, snap);
  }

  private notifySelection(client: IdeClient, snap: EditorSelectionSnapshot): void {
    this.send(client, { jsonrpc: '2.0', method: 'selection_changed', params: selectionChangedParams(snap) });
  }

  private send(client: IdeClient, message: unknown): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify(message), (err) => {
      if (err) this.log.debug('IDE send failed:', err.message);
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
