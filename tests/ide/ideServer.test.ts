import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { IDE_OFF_MESSAGE, IdeServer, IdeStartAbortedError, selectionChangedParams } from '../../src/bridge/ideServer';
import { createLogger, redact } from '../../src/util/log';
import { silentSink } from '../bridge/helpers';
import { FakeSelectionSource, connect, sleep, snapshot, tcpConnects, type IdeTestClient } from './helpers';

const TOKEN = 'ide-token-0123456789';
const servers: IdeServer[] = [];
const clients: IdeTestClient[] = [];

async function startServer(opts: { state?: FakeSelectionSource | null; seedDelaysMs?: number[] } = {}) {
  const sink = silentSink();
  const state = opts.state === undefined ? new FakeSelectionSource() : opts.state;
  const server = new IdeServer({ log: createLogger('ide', sink), state, token: TOKEN, version: '9.9.9', seedDelaysMs: opts.seedDelaysMs ?? [20] });
  servers.push(server);
  await server.start();
  return { server, state, sink };
}

async function client(server: IdeServer) {
  const r = await connect(server.port!, TOKEN);
  if (!r.ok) throw new Error(r.error);
  clients.push(r.client);
  return r.client;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const s of servers.splice(0)) s.dispose();
});

describe('IDE WebSocket server — auth (R10.2)', () => {
  it('listens on 127.0.0.1 and accepts the token in X-Claude-Code-Ide-Authorization with subprotocol mcp', async () => {
    const { server } = await startServer();
    expect(server.isRunning()).toBe(true);
    const r = await connect(server.port!, TOKEN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      clients.push(r.client);
      expect(r.client.ws.protocol).toBe('mcp');
    }
  });

  it.each([
    ['no auth header', null],
    ['a wrong token', 'wrong-token-0123456789'],
    ['a token prefix', TOKEN.slice(0, -1)],
    ['the token with extra characters', `${TOKEN}x`],
  ])('rejects an upgrade with %s (401, no connection)', async (_label, token) => {
    const { server } = await startServer();
    const r = await connect(server.port!, token);
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(server.clientCount()).toBe(0);
  });

  it('rejects the token in another header (e.g. Authorization: Bearer)', async () => {
    const { server } = await startServer();
    expect(await connect(server.port!, `Bearer ${TOKEN}`, { headerName: 'Authorization' })).toMatchObject({ ok: false, status: 401 });
  });

  it('answers plain HTTP requests with 426 and never leaks the token', async () => {
    const { server, sink } = await startServer();
    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.port!, path: '/', headers: { 'X-Claude-Code-Ide-Authorization': TOKEN } }, (res) => {
          let text = '';
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        })
        .on('error', reject);
    });
    expect(body.status).toBe(426);
    expect(body.text).not.toContain(TOKEN);
    await connect(server.port!, 'wrong-token-0123456789');
    expect(sink.lines.join('\n')).not.toContain(TOKEN);
    expect(redact(`x ${TOKEN} y`)).not.toContain(TOKEN); // registered as a secret
  });
});

describe('IDE WebSocket server — MCP', () => {
  it('initialize echoes a supported protocol version, declares tools and serverInfo "Obsidian"', async () => {
    const { server } = await startServer();
    const c = await client(server);
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.292' } });
    expect(init.result).toEqual({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'Obsidian', version: '9.9.9' } });
    const newer = await c.request('initialize', { protocolVersion: '2099-01-01' });
    expect(newer.result.protocolVersion).toBe('2025-11-25');
  });

  it('tools/list is empty; ping works; every tool call (openDiff, close_tab, getDiagnostics …) is refused', async () => {
    const { server } = await startServer();
    const c = await client(server);
    await c.handshake();
    expect((await c.request('tools/list')).result).toEqual({ tools: [] });
    expect((await c.request('ping')).result).toEqual({});
    for (const name of ['openDiff', 'close_tab', 'closeAllDiffTabs', 'getDiagnostics', 'openFile', 'saveDocument', 'checkDocumentDirty', 'getCurrentSelection']) {
      const r = await c.request('tools/call', { name, arguments: {} });
      expect(r.result).toBeUndefined();
      expect(r.error).toMatchObject({ code: -32602 });
      expect(r.error!.message).toContain(name);
    }
  });

  it('unknown methods → -32601; bad JSON → -32700; batches / bad ids → -32600; responses and unknown notifications are ignored', async () => {
    const { server } = await startServer();
    const c = await client(server);
    const r = await c.request('resources/list');
    expect(r.error).toEqual({ code: -32601, message: 'Method not found: resources/list' });
    c.send('{nope');
    expect((await c.next((m) => m.error?.code === -32700)).id).toBeNull();
    c.send(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
    await c.next((m) => m.error?.code === -32600);
    c.send(JSON.stringify({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }));
    await c.next((m) => m.error?.message === 'Invalid request id');
    const count = c.messages.length;
    c.send(JSON.stringify({ jsonrpc: '2.0', id: 5, result: {} }));
    c.notify('some/notification', {});
    expect((await c.request('ping')).result).toEqual({}); // still alive
    expect(c.messages.length).toBe(count + 1);
  });
});

describe('IDE WebSocket server — selection_changed (R10.4, R10.5)', () => {
  it('payload: absolute filePath, fileUrl, 0-based start/end, isEmpty, text', () => {
    expect(selectionChangedParams(snapshot({ absolutePath: '/v/Notes/한글 X.md' }))).toEqual({
      text: 'line 2\nline 3\nline 4\n',
      filePath: '/v/Notes/한글 X.md',
      fileUrl: 'file:///v/Notes/%ED%95%9C%EA%B8%80%20X.md',
      selection: { start: { line: 1, character: 0 }, end: { line: 4, character: 0 }, isEmpty: false },
    });
  });

  it('pushes every bridgeState change to initialized clients only', async () => {
    const { server, state } = await startServer({ seedDelaysMs: [] });
    const early = await client(server); // connected, handshake not done
    const c = await client(server);
    await c.handshake();
    await sleep(20);
    expect(server.clientCount()).toBe(1);
    state!.emit(snapshot());
    const msg = await c.next((m) => m.method === 'selection_changed');
    expect(msg).toEqual({ jsonrpc: '2.0', method: 'selection_changed', params: selectionChangedParams(snapshot()) });
    state!.emit(snapshot({ text: '', from: { line: 3, ch: 2 }, to: { line: 3, ch: 2 }, isEmpty: true }));
    const empty = await c.next((m) => m.method === 'selection_changed' && m.params.selection.isEmpty === true);
    expect(empty.params).toMatchObject({ text: '', filePath: '/vault/Notes/X.md', selection: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } } });
    expect(early.selections()).toEqual([]);
  });

  it('seeds a new client with the current selection after its handshake (not before)', async () => {
    const state = new FakeSelectionSource();
    state.current = snapshot();
    const { server } = await startServer({ state, seedDelaysMs: [30, 90] });
    const c = await client(server);
    await sleep(120);
    expect(c.selections()).toEqual([]); // no handshake yet → nothing
    await c.handshake();
    await sleep(50);
    expect(c.selections()).toHaveLength(1);
    await sleep(80);
    expect(c.selections()).toHaveLength(2); // re-sent once (Claude may not listen yet at the first one)
    expect(c.selections()[1]!.params).toEqual(selectionChangedParams(snapshot()));
  });

  it('sends nothing on its own: no seed without a selection, nothing when bridgeState stays silent (terminal focus)', async () => {
    const { server } = await startServer({ seedDelaysMs: [10] });
    const c = await client(server);
    await c.handshake();
    await sleep(80);
    expect(c.selections()).toEqual([]);
  });

  it('works without a selection source', async () => {
    const { server } = await startServer({ state: null, seedDelaysMs: [5] });
    const c = await client(server);
    await c.handshake();
    await sleep(30);
    expect(c.selections()).toEqual([]);
  });
});

describe('IDE WebSocket server — lifecycle (deviation 21)', () => {
  it('setAccepting(false) is synchronous: clients dropped, unsubscribed, port still bound, token → 403, no token → 401', async () => {
    const { server, state } = await startServer();
    const port = server.port!;
    const c = await client(server);
    await c.handshake();
    expect(state!.listenerCount()).toBe(1);
    const closed = new Promise<void>((r) => c.ws.once('close', () => r()));
    server.setAccepting(false);
    expect(server.isAccepting()).toBe(false);
    expect(server.isRunning()).toBe(true);
    expect(server.port).toBe(port);
    expect(server.clientCount()).toBe(0);
    expect(state!.listenerCount()).toBe(0);
    await closed;
    expect(await tcpConnects(port)).toBe(true);
    expect(await connect(port, TOKEN)).toMatchObject({ ok: false, status: 403 });
    expect(await connect(port, null)).toMatchObject({ ok: false, status: 401 });
    expect(await connect(port, 'wrong-token-0123456789')).toMatchObject({ ok: false, status: 401 });
    await expect(server.whenListening()).resolves.toBeUndefined();

    server.setAccepting(true);
    expect(server.port).toBe(port);
    expect(state!.listenerCount()).toBe(1);
    const again = await client(server);
    await again.handshake();
    state!.emit(snapshot());
    expect((await again.next((m) => m.method === 'selection_changed')).params).toEqual(selectionChangedParams(snapshot()));
  });

  it('the 403 body says the connection is off and never contains the token', async () => {
    const { server, sink } = await startServer();
    server.setAccepting(false);
    const res = await rawUpgrade(server.port!, TOKEN);
    expect(res).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(res).toContain(IDE_OFF_MESSAGE);
    expect(res).not.toContain(TOKEN);
    expect(sink.lines.join('\n')).not.toContain(TOKEN);
  });

  it('start() is a no-op once bound; a server that starts while not accepting refuses until setAccepting(true)', async () => {
    const server = new IdeServer({ log: createLogger('ide', silentSink()), state: null, token: TOKEN });
    servers.push(server);
    server.setAccepting(false);
    await server.start();
    const port = server.port!;
    expect(await connect(port, TOKEN)).toMatchObject({ ok: false, status: 403 });
    await server.start();
    expect(server.port).toBe(port);
    server.setAccepting(true);
    const r = await connect(port, TOKEN);
    expect(r.ok).toBe(true);
    if (r.ok) clients.push(r.client);
  });

  it('dispose() closes the port and drops clients synchronously; it cannot start again', async () => {
    const { server, state } = await startServer();
    const port = server.port!;
    const c = await client(server);
    const closed = new Promise<void>((r) => c.ws.once('close', () => r()));
    server.dispose();
    expect(server.isRunning()).toBe(false);
    expect(server.port).toBeNull();
    expect(state!.listenerCount()).toBe(0);
    await closed;
    expect(await tcpConnects(port)).toBe(false);
    await expect(server.whenListening()).rejects.toThrow(/not listening/);
    await expect(server.start()).rejects.toBeInstanceOf(IdeStartAbortedError);
  });

  it('dispose() while starting rejects the start', async () => {
    const server = new IdeServer({ log: createLogger('ide', silentSink()), state: null, token: TOKEN });
    servers.push(server);
    const starting = server.start();
    expect(server.whenListening()).toBe(starting);
    server.dispose();
    await expect(starting).rejects.toBeInstanceOf(IdeStartAbortedError);
    expect(server.isRunning()).toBe(false);
  });
});

/** A raw WebSocket upgrade request; resolves with the whole answer. */
function rawUpgrade(port: number, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: mcp\r\nX-Claude-Code-Ide-Authorization: ${token}\r\n\r\n`,
      );
    });
    let text = '';
    socket.on('data', (d) => (text += d.toString()));
    socket.once('close', () => resolve(text));
    socket.once('error', reject);
  });
}
