import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID, timingSafeEqual } from 'crypto';
import * as http from 'http';
import type { AddressInfo, Socket } from 'net';
import type { BridgeRouteRegistry, Disposer } from '../core';
import { readBody } from '../util/http';
import { registerSecret, type Logger } from '../util/log';

export const BRIDGE_HOST = '127.0.0.1';
export const MCP_PATH = '/mcp';
/** Larger request bodies get 413. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Status of a refused request (right token, but the feature it asks for is turned off). */
export const REFUSED_STATUS = 403;
/** `/mcp` while the Bridge tools setting is off (shown by agy through mcp_shim.py). */
export const TOOLS_OFF_MESSAGE = 'Obsidian bridge tools are turned off in the AI Terminal settings.';
/** Any request while nothing uses the server (Bridge tools and snapshots both off). */
export const NOT_IN_USE_MESSAGE = 'The Obsidian bridge is not in use: Bridge tools and AI session snapshots are turned off in the AI Terminal settings.';

/** `start()` gave up because the server was disposed (plugin unload) — not a failure worth a Notice. */
export class BridgeStartAbortedError extends Error {
  constructor() {
    super('The Obsidian bridge server was closed while starting.');
    this.name = 'BridgeStartAbortedError';
  }
}

/** Where the bridge server listens and its token — what spawn contributors need. */
export interface BridgeEndpoint {
  /** MCP endpoint, `http://127.0.0.1:<port>/mcp`; null until the server listens. */
  readonly url: string | null;
  /** `http://127.0.0.1:<port>` (no trailing slash); null until the server listens. Append a route path, e.g. `/snapshot`. */
  readonly baseUrl: string | null;
  /** Fixed for the whole plugin session once listening (deviation 20). */
  readonly port: number | null;
  /** Per-run bearer token (registered with the redacting logger). Stays the same while the plugin is loaded. */
  readonly token: string;
  /** Resolves once listening; rejects if nothing has needed the server yet in this plugin session, or it failed to start. */
  whenListening(): Promise<void>;
  /** The port is bound (it stays bound until the plugin unloads). */
  isRunning(): boolean;
}

/**
 * The `bridgeServer` service (D11, D27b, R9): the bridge's HTTP server on `127.0.0.1:<random port>`. Every request needs
 * `Authorization: Bearer <token>`; `/mcp` is the MCP Streamable HTTP endpoint (stateless, JSON responses — POST only)
 * while the bridge tools are on, every other path goes to `ctx.routes` (e.g. T9's `POST /snapshot`). One server per
 * plugin instance = per vault (D12). It is *in use* while the bridge tools are on or another module needs its routes
 * (deviation 19: snapshots keep `/snapshot` with the tools off — `/mcp` is then refused).
 * Deviation 20: the port is bound the first time the server is in use and stays bound until the plugin unloads, so no
 * other program can take a port that running panels still send their token to. While it is not in use, every request
 * is refused (403, after the 401 token check) with a JSON-RPC error body that says why.
 */
export interface BridgeServerService extends BridgeEndpoint {
  /** True while the bridge tools are on or a `keepRunningWhile` reason is needed; otherwise requests are refused. */
  isServing(): boolean;
  /**
   * Keeps the server in use while `needed()` is true, even with the bridge tools off (the first need binds the port).
   * Checked when the plugin becomes ready, after every settings change and on every request, so `needed` should depend
   * on settings only. Returns a disposer.
   */
  keepRunningWhile(reason: string, needed: () => boolean): Disposer;
}

declare module '../core/services' {
  interface ServiceMap {
    bridgeServer: BridgeServerService;
  }
}

export interface BridgeHttpServerOptions {
  routes: BridgeRouteRegistry;
  /** Builds the MCP server for one request (stateless mode: a fresh server + transport per request). */
  createMcpServer: () => McpServer;
  log: Logger;
  /** Fixed token (tests); default `crypto.randomUUID()`. */
  token?: string;
  /** Whether `/mcp` is served (the bridge tools setting); read per request. Default: always. Off → refused (403). */
  serveMcp?: () => boolean;
  /** Called when a `keepRunningWhile` reason is added or removed. */
  onDemandChange?: () => void;
}

type Phase = 'stopped' | 'starting' | 'running';

export class BridgeHttpServer implements BridgeServerService {
  readonly token: string;
  private readonly unregisterSecret: () => void;
  private readonly tokenBuf: Buffer;
  private readonly sockets = new Set<Socket>();
  private server: http.Server | null = null;
  private phase: Phase = 'stopped';
  private startPromise: Promise<void> | null = null;
  private abortStart: (() => void) | null = null;
  private currentPort: number | null = null;
  private disposed = false;
  private readonly demands = new Map<symbol, { reason: string; needed: () => boolean }>();

  constructor(private readonly opts: BridgeHttpServerOptions) {
    this.token = opts.token ?? randomUUID();
    this.tokenBuf = Buffer.from(this.token);
    this.unregisterSecret = registerSecret(this.token);
  }

  get port(): number | null {
    return this.currentPort;
  }

  get baseUrl(): string | null {
    return this.currentPort === null ? null : `http://${BRIDGE_HOST}:${this.currentPort}`;
  }

  get url(): string | null {
    const base = this.baseUrl;
    return base === null ? null : `${base}${MCP_PATH}`;
  }

  isRunning(): boolean {
    return this.phase === 'running';
  }

  whenListening(): Promise<void> {
    if (this.phase === 'running') return Promise.resolve();
    if (this.phase === 'starting' && this.startPromise) return this.startPromise;
    return Promise.reject(new Error('The Obsidian bridge server is not running (not needed yet, failed to start, or closed).'));
  }

  isServing(): boolean {
    return this.toolsOn() || this.neededFor().length > 0;
  }

  keepRunningWhile(reason: string, needed: () => boolean): Disposer {
    const key = Symbol(reason);
    this.demands.set(key, { reason, needed });
    this.opts.onDemandChange?.();
    return () => {
      if (this.demands.delete(key)) this.opts.onDemandChange?.();
    };
  }

  /** The `keepRunningWhile` reasons whose `needed()` is true right now (a throwing check counts as not needed). */
  neededFor(): string[] {
    const reasons: string[] = [];
    for (const { reason, needed } of this.demands.values()) {
      try {
        if (needed()) reasons.push(reason);
      } catch (err) {
        this.opts.log.warn(`bridge server demand "${reason}" failed`, err);
      }
    }
    return reasons;
  }

  /** Binds a random free port (no-op while starting / running). Once bound, only `dispose()` closes it (deviation 20). */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new BridgeStartAbortedError());
    if (this.phase !== 'stopped' && this.startPromise) return this.startPromise;
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server = server;
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
        server.listen({ port, host: BRIDGE_HOST, exclusive: true });
      });
    // dispose() during listen(): Node then never emits 'listening' (nor 'error'), so dispose() rejects through this hook.
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new BridgeStartAbortedError());
    });
    this.abortStart = abort;
    const promise = Promise.race([listen(0), aborted])
      .finally(() => {
        if (this.abortStart === abort) this.abortStart = null;
      })
      .then(
        () => {
          if (this.server !== server) {
            server.close();
            throw new BridgeStartAbortedError();
          }
          this.currentPort = (server.address() as AddressInfo).port;
          this.phase = 'running';
          server.on('error', (err) => this.opts.log.error('bridge server error', err));
          this.opts.log.info(`bridge listening on ${this.url}`);
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

  /**
   * Plugin unload: closes the port, drops every connection and forgets the token — synchronous, so it completes during
   * unload (R9.5). The server cannot start again afterwards.
   */
  dispose(): void {
    this.disposed = true;
    this.close();
    this.unregisterSecret();
  }

  private close(): void {
    const server = this.server;
    if (!server) return;
    this.reset();
    this.abortStart?.();
    server.close();
    server.closeAllConnections?.();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.opts.log.info('bridge stopped');
  }

  private toolsOn(): boolean {
    return this.opts.serveMcp ? this.opts.serveMcp() : true;
  }

  private reset(): void {
    this.server = null;
    this.phase = 'stopped';
    this.startPromise = null;
    this.currentPort = null;
  }

  private authorized(req: http.IncomingMessage): boolean {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(req.headers.authorization ?? '');
    if (!match) return false;
    const given = Buffer.from(match[1] ?? '');
    return given.length === this.tokenBuf.length && timingSafeEqual(given, this.tokenBuf);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (!this.authorized(req)) {
        sendJson(res, 401, { error: 'unauthorized', message: 'Missing or wrong bearer token.' }, { 'WWW-Authenticate': 'Bearer' });
        req.resume();
        return;
      }
      const path = (req.url ?? '/').split('?', 1)[0] ?? '/';
      // Refusals come after the token check, so only the token holder learns why (deviations 19, 20).
      if (path === MCP_PATH && !this.toolsOn()) {
        refuse(req, res, TOOLS_OFF_MESSAGE);
        return;
      }
      if (!this.isServing()) {
        refuse(req, res, NOT_IN_USE_MESSAGE);
        return;
      }
      if (path === MCP_PATH) {
        await this.handleMcp(req, res);
        return;
      }
      const route = this.opts.routes.match(req.method, req.url);
      if (!route) {
        sendJson(res, 404, { error: 'not_found', message: `No route for ${req.method ?? '?'} ${path}` });
        req.resume();
        return;
      }
      await route(req, res);
    } catch (err) {
      this.opts.log.error(`bridge request ${req.method ?? '?'} ${req.url ?? ''} failed`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    }
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
      sendJson(res, 405, rpcError(-32000, 'Method not allowed: this MCP server is stateless; use POST.'), { Allow: 'POST' });
      req.resume();
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === 'too-large') {
      sendJson(res, 413, rpcError(-32000, `Request body larger than ${MAX_BODY_BYTES} bytes`));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, rpcError(-32700, 'Parse error: invalid JSON'));
      return;
    }
    // The SDK's Node adapter reads `rawBody` instead of the (already consumed) request stream if it ever needs the body.
    (req as http.IncomingMessage & { rawBody?: Buffer }).rawBody = body;
    const mcp = this.opts.createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transport.onerror = (err) => this.opts.log.debug('mcp transport:', err.message);
    res.on('close', () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsed);
  }
}

function rpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function refuse(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
  sendJson(res, REFUSED_STATUS, rpcError(-32000, message));
  req.resume();
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}
