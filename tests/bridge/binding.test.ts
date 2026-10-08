// R9.1 — the bridge's HTTP server listens on 127.0.0.1 only. Inspects the real listening socket (not the URL the
// service reports) and tries to reach the port through every other address of this Mac.
import * as net from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeModule } from '../../src/bridge/index';
import { createBridgeEnv, startRuntime } from './helpers';

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const runtimes: Runtime[] = [];

afterEach(() => {
  for (const rt of runtimes.splice(0)) if (!rt.ctx.unloading) rt.runtime.unload();
  vi.restoreAllMocks();
});

/** Every server that starts listening while `fn` runs. */
async function serversStartedBy(fn: () => Promise<void>): Promise<net.Server[]> {
  const servers: net.Server[] = [];
  const listen = net.Server.prototype.listen;
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server, ...args: unknown[]) {
    servers.push(this);
    return (listen as (...a: unknown[]) => net.Server).apply(this, args);
  });
  await fn();
  return servers;
}

/** Resolves with the connect error code, or 'connected'. */
function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: string): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(2_000, () => done('timeout'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code ?? err.message));
  });
}

function otherAddresses(): Array<{ address: string; family: string; iface: string }> {
  const out: Array<{ address: string; family: string; iface: string }> = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, family: a.family, iface });
    }
  }
  return out;
}

describe('R9.1: the bridge listens only on localhost', () => {
  it('the listening socket is 127.0.0.1:<random port> (IPv4), and no other interface of this Mac reaches it', async () => {
    let rt!: Runtime;
    const servers = await serversStartedBy(async () => {
      rt = await startRuntime(createBridgeEnv(), [createBridgeModule()]); // default settings: bridge tools on
      runtimes.push(rt);
      await rt.ctx.services.require('bridgeServer').whenListening();
    });
    const service = rt.ctx.services.require('bridgeServer');
    expect(service.isRunning()).toBe(true);
    const port = service.port!;
    expect(port).toBeGreaterThan(0);

    const bound = servers.map((s) => s.address()).filter((a): a is net.AddressInfo => typeof a === 'object' && a !== null && a.port === port);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toEqual({ address: '127.0.0.1', family: 'IPv4', port });
    expect(service.url).toBe(`http://127.0.0.1:${port}/mcp`);

    // Positive control: the port answers on 127.0.0.1.
    expect(await tryConnect('127.0.0.1', port)).toBe('connected');
    // Every non-internal IPv4 address of this Mac (Wi-Fi, Ethernet, VPN …) is refused.
    const refused: Record<string, string> = {};
    for (const { address } of otherAddresses()) refused[address] = await tryConnect(address, port);
    expect(refused).toEqual(Object.fromEntries(Object.keys(refused).map((a) => [a, 'ECONNREFUSED'])));
    // So is the IPv6 loopback (EADDRNOTAVAIL when IPv6 is off).
    expect(['ECONNREFUSED', 'EADDRNOTAVAIL']).toContain(await tryConnect('::1', port));
  });

  it('a second plugin load (another vault) also binds 127.0.0.1 only, on a different port', async () => {
    const servers = await serversStartedBy(async () => {
      for (let i = 0; i < 2; i++) {
        const rt = await startRuntime(createBridgeEnv(), [createBridgeModule()]);
        runtimes.push(rt);
        await rt.ctx.services.require('bridgeServer').whenListening();
      }
    });
    const ports = runtimes.map((rt) => rt.ctx.services.require('bridgeServer').port!);
    expect(new Set(ports).size).toBe(2);
    const addresses = servers.map((s) => s.address()).filter((a): a is net.AddressInfo => typeof a === 'object' && a !== null && ports.includes(a.port));
    expect(addresses.map((a) => [a.address, a.family]).sort()).toEqual([
      ['127.0.0.1', 'IPv4'],
      ['127.0.0.1', 'IPv4'],
    ]);
  });
});
