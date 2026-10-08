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

/** Where the bridge server listens and its token — what spawn contributors need. */
export interface BridgeEndpoint {
  /** MCP endpoint, `http://127.0.0.1:<port>/mcp`; null while not listening. */
  readonly url: string | null;
  /** `http://127.0.0.1:<port>` (no trailing slash); null while not listening. Append a route path, e.g. `/snapshot`. */
  readonly baseUrl: string | null;
  readonly port: number | null;
  /** Per-run bearer token (registered with the redacting logger). Stays the same while the plugin is loaded. */
  readonly token: string;
  /** Resolves once listening; rejects if the server is disabled / stopped or fails to start. */
  whenListening(): Promise<void>;
  isRunning(): boolean;
}

/**
 * The `bridgeServer` service (D11, D27b, R9): the bridge's HTTP server on `127.0.0.1:<random port>`. Every request needs
 * `Authorization: Bearer <token>`; `/mcp` is the MCP Streamable HTTP endpoint (stateless, JSON responses — POST only)
 * while the bridge tools are on, every other path goes to `ctx.routes` (e.g. T9's `POST /snapshot`). One server per
 * plugin instance = per vault (D12). It listens while the bridge tools are on or another module needs its routes
 * (deviation 19: snapshots keep `/snapshot` with the tools off — `/mcp` then answers 404).
 */
export interface BridgeServerService extends BridgeEndpoint {
  /**
   * Keeps the server listening while `needed()` is true, even with the bridge tools off. Checked when the plugin
   * becomes ready and after every settings change, so `needed` should depend on settings only. Returns a disposer.
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
  /** Whether `/mcp` is served (the bridge tools setting); read per request. Default: always. Off → 404. */
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
  /** Port of the previous run: reused on restart so sessions started earlier can reconnect. */
  private lastPort = 0;
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
    return Promise.reject(new Error('The Obsidian bridge server is not running (disabled in settings or stopped).'));
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

  /** Starts listening (no-op while starting / running). */
  start(): Promise<void> {
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
    // stop() during listen(): Node then never emits 'listening' (nor 'error'), so stop() rejects through this hook.
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('The Obsidian bridge server was stopped while starting.'));
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
            throw new Error('The Obsidian bridge server was stopped while starting.');
          }
          this.currentPort = (server.address() as AddressInfo).port;
          this.lastPort = this.currentPort;
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

  /** Closes the port and drops every connection — synchronous, so it completes during plugin unload (R9.5). */
  stop(): void {
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

  /** `stop()` and forget the token (plugin unload). */
  dispose(): void {
    this.stop();
    this.unregisterSecret();
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
      if (path === MCP_PATH) {
        if (this.opts.serveMcp && !this.opts.serveMcp()) {
          sendJson(res, 404, { error: 'not_found', message: 'The Obsidian bridge tools are turned off in the AI Terminal settings.' });
          req.resume();
          return;
        }
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

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}
