import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeHttpServer } from '../../src/bridge/httpServer';
import { BridgeError } from '../../src/bridge/paths';
import type { BridgeStateService } from '../../src/bridge/state';
import { BRIDGE_TOOL_NAMES, createBridgeMcpServer } from '../../src/bridge/tools';
import { BridgeRouteRegistry } from '../../src/core/routes';
import { createLogger, redact } from '../../src/util/log';
import { silentSink } from './helpers';

const TOKEN = 'test-token-0123456789';

function fakeState(): BridgeStateService {
  return {
    getActiveNote: () => ({ path: 'Notes/X.md', content: 'hello', cursorLine: 12 }),
    getSelection: () => ({ path: 'Notes/X.md', text: 'sel', fromLine: 3, toLine: 5 }),
    listOpenNotes: () => [{ path: 'A.md', active: false }, { path: 'B.md', active: true }],
    getLinks: (p) => {
      if (p !== 'A.md') throw new BridgeError(`Note not found: "${p}".`, 'not-found');
      return { outgoing: ['B.md'], backlinks: ['C.md'] };
    },
    openNote: vi.fn(async (p: string, line?: number) => {
      if (p.startsWith('..')) throw new BridgeError('Path leaves the vault: "../x.md".', 'invalid-path');
      return line ? { opened: p, line } : { opened: p };
    }),
    currentSelection: () => null,
    onChange: () => () => {},
  };
}

const servers: BridgeHttpServer[] = [];
const clients: Client[] = [];

async function startServer(routes = new BridgeRouteRegistry(), state = fakeState()) {
  const server = new BridgeHttpServer({ routes, createMcpServer: () => createBridgeMcpServer(state), log: createLogger('t', silentSink()), token: TOKEN });
  servers.push(server);
  await server.start();
  return { server, routes, state };
}

async function connect(url: string, token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

function request(port: number, opts: { method?: string; path?: string; auth?: string; body?: string; host?: string }) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (opts.auth !== undefined) headers.Authorization = opts.auth;
    const req = http.request({ host: opts.host ?? '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(opts.body ?? '');
  });
}

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) s.dispose();
});

describe('BridgeHttpServer (R9)', () => {
  it('R9.1: listens on 127.0.0.1 only, on a random port', async () => {
    const { server } = await startServer();
    const port = server.port!;
    expect(port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(server.baseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(server.isRunning()).toBe(true);
    await expect(server.whenListening()).resolves.toBeUndefined();
    const ipv6 = await new Promise<string>((resolve) => {
      const s = net.connect({ host: '::1', port });
      s.on('connect', () => (s.destroy(), resolve('connected')));
      s.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(ipv6).not.toBe('connected');
  });

  it('R9.2: no token / wrong token → 401 before routing; the right token → valid MCP response', async () => {
    const routes = new BridgeRouteRegistry();
    const handler = vi.fn((_req: http.IncomingMessage, res: http.ServerResponse) => void res.end('ok'));
    routes.addRoute('POST', '/snapshot', handler);
    const { server } = await startServer(routes);
    const port = server.port!;
    for (const auth of [undefined, '', `Bearer wrong-token-0123456789`, `Bearer ${TOKEN}x`, TOKEN, `Basic ${TOKEN}`]) {
      expect((await request(port, { auth, body: INIT })).status).toBe(401);
      expect((await request(port, { auth, path: '/snapshot' })).status).toBe(401);
      expect((await request(port, { auth, path: '/nowhere' })).status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
    const ok = await request(port, { auth: `Bearer ${TOKEN}`, body: INIT });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'obsidian' }, capabilities: { tools: {} } } });
    expect((await request(port, { auth: `bearer ${TOKEN}`, body: INIT })).status).toBe(200);
  });

  it('R9.3 / R8.8: initialize, tools/list = exactly the five tools, tools/call via the SDK client', async () => {
    const { server } = await startServer();
    const client = await connect(server.url!);
    expect(client.getServerVersion()).toMatchObject({ name: 'obsidian' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...BRIDGE_TOOL_NAMES].sort());
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(40);
    expect(tools.find((t) => t.name === 'open_note')!.inputSchema).toMatchObject({ required: ['path'], properties: { path: { type: 'string' }, line: { type: 'integer' } } });

    const note = await client.callTool({ name: 'get_active_note', arguments: {} });
    expect(note.isError).toBeFalsy();
    expect(JSON.parse((note.content as Array<{ text: string }>)[0]!.text)).toEqual({ path: 'Notes/X.md', content: 'hello', cursorLine: 12 });
    const list = await client.callTool({ name: 'list_open_notes', arguments: {} });
    expect(JSON.parse((list.content as Array<{ text: string }>)[0]!.text)).toEqual([{ path: 'A.md', active: false }, { path: 'B.md', active: true }]);
    const links = await client.callTool({ name: 'get_links', arguments: { path: 'A.md' } });
    expect(JSON.parse((links.content as Array<{ text: string }>)[0]!.text)).toEqual({ outgoing: ['B.md'], backlinks: ['C.md'] });
  });

  it('tool failures are MCP tool errors (isError), not protocol errors', async () => {
    const { server, state } = await startServer();
    const client = await connect(server.url!);
    const missing = await client.callTool({ name: 'get_links', arguments: { path: 'Nope.md' } });
    expect(missing).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Note not found: "Nope.md".' }] });
    const outside = await client.callTool({ name: 'open_note', arguments: { path: '../x.md' } });
    expect(outside.isError).toBe(true);
    const badLine = await client.callTool({ name: 'open_note', arguments: { path: 'A.md', line: 0 } });
    expect(badLine.isError).toBe(true);
    expect(state.openNote).toHaveBeenCalledTimes(1);
    const opened = await client.callTool({ name: 'open_note', arguments: { path: 'A.md', line: 4 } });
    expect(JSON.parse((opened.content as Array<{ text: string }>)[0]!.text)).toEqual({ opened: 'A.md', line: 4 });
  });

  it('serves two clients at once (stateless)', async () => {
    const { server } = await startServer();
    const [a, b] = await Promise.all([connect(server.url!), connect(server.url!)]);
    const calls = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).callTool({ name: i % 3 ? 'get_selection' : 'list_open_notes', arguments: {} })),
    );
    expect(calls.every((c) => !c.isError)).toBe(true);
    expect((await a.listTools()).tools).toHaveLength(5);
    expect((await b.listTools()).tools).toHaveLength(5);
  });

  it('routes other paths to ctx.routes (added after start), 404 otherwise; GET /mcp → 405', async () => {
    const routes = new BridgeRouteRegistry();
    const { server } = await startServer(routes);
    const port = server.port!;
    const auth = `Bearer ${TOKEN}`;
    expect((await request(port, { auth, path: '/snapshot' })).status).toBe(404);
    routes.addRoute('POST', '/snapshot', async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ got: JSON.parse(body) }));
    });
    const r = await request(port, { auth, path: '/snapshot?x=1', body: '{"panelId":"p1"}' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ got: { panelId: 'p1' } });
    expect((await request(port, { auth, method: 'GET', path: '/snapshot' })).status).toBe(404);
    const get = await request(port, { auth, method: 'GET', path: '/mcp' });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await request(port, { auth, body: '{not json' })).status).toBe(400);
  });

  it('a throwing route answers 500', async () => {
    const routes = new BridgeRouteRegistry();
    routes.addRoute('POST', '/boom', () => {
      throw new Error('boom');
    });
    const { server } = await startServer(routes);
    expect((await request(server.port!, { auth: `Bearer ${TOKEN}`, path: '/boom' })).status).toBe(500);
  });

  it('R9.5: stop() closes the port synchronously, drops open connections; restart reuses the port', async () => {
    const { server } = await startServer();
    const port = server.port!;
    const client = await connect(server.url!);
    await client.listTools();
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    await new Promise((r) => socket.on('connect', r));
    const closed = new Promise((r) => socket.on('close', r));
    server.stop();
    expect(server.isRunning()).toBe(false);
    expect(server.url).toBeNull();
    await expect(server.whenListening()).rejects.toThrow(/not running/);
    await closed;
    await expect(request(port, { auth: `Bearer ${TOKEN}`, body: INIT })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await server.start();
    expect(server.port).toBe(port);
  });

  it('stop() while starting leaves nothing listening', async () => {
    const server = new BridgeHttpServer({ routes: new BridgeRouteRegistry(), createMcpServer: () => createBridgeMcpServer(fakeState()), log: createLogger('t', silentSink()) });
    servers.push(server);
    const p = server.start();
    server.stop();
    await expect(p).rejects.toThrow();
    expect(server.isRunning()).toBe(false);
  });

  it('the token is random per instance and redacted from logs until disposed', () => {
    const a = new BridgeHttpServer({ routes: new BridgeRouteRegistry(), createMcpServer: () => createBridgeMcpServer(fakeState()), log: createLogger('t', silentSink()) });
    const b = new BridgeHttpServer({ routes: new BridgeRouteRegistry(), createMcpServer: () => createBridgeMcpServer(fakeState()), log: createLogger('t', silentSink()) });
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(redact(`x ${a.token} y`)).toBe('x [REDACTED] y');
    a.dispose();
    b.dispose();
    expect(redact(`x ${a.token}`)).toBe(`x ${a.token}`);
  });
});
