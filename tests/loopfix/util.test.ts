// Loop iteration 2 — helpers moved to src/util/ (behaviour-preserving de-duplication).
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as lockFile from '../../src/bridge/lockFile';
import * as closeFlow from '../../src/terminal/closeFlow';
import { readBody } from '../../src/util/http';
import { openModalIn } from '../../src/util/modal';
import { isExecutableFile, isPidAlive } from '../../src/util/process';
import { spawnEnv } from '../../src/util/spawnEnv';
import { listensWithin } from '../../src/util/wait';

describe('src/util helpers', () => {
  it('listensWithin: true when listening (now or soon), false when it rejects or is too slow', async () => {
    expect(await listensWithin({ whenListening: () => Promise.resolve() }, 50)).toBe(true);
    expect(await listensWithin({ whenListening: () => new Promise((r) => setTimeout(r, 10)) }, 500)).toBe(true);
    expect(await listensWithin({ whenListening: () => Promise.reject(new Error('off')) }, 500)).toBe(false);
    const t0 = Date.now();
    expect(await listensWithin({ whenListening: () => new Promise(() => {}) }, 50)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('readBody: the whole body as a Buffer, or "too-large" past the limit', async () => {
    const results: Array<Buffer | 'too-large'> = [];
    const server = http.createServer((req, res) => {
      void readBody(req, 8).then((b) => {
        results.push(b);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const send = (body: string) =>
      new Promise<void>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', agent: false }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end(body);
      });
    try {
      await send('한글ok');
      await send('0123456789');
      await send('');
    } finally {
      server.close();
    }
    expect(results[0]).toEqual(Buffer.from('한글ok'));
    expect(results[1]).toBe('too-large');
    expect(results[2]).toEqual(Buffer.alloc(0));
  });

  it('isPidAlive / isExecutableFile', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'exec-'));
    const script = join(dir, 'tool');
    writeFileSync(script, '#!/bin/sh\n');
    expect(isExecutableFile(script)).toBe(false);
    chmodSync(script, 0o755);
    expect(isExecutableFile(script)).toBe(true);
    expect(isExecutableFile(dir)).toBe(false);
    expect(isExecutableFile(join(dir, 'missing'))).toBe(false);
  });

  it('spawnEnv: the shellEnv layer when available, else process.env (also when it throws)', () => {
    const services = (get: () => unknown) => ({ services: { get } }) as unknown as Parameters<typeof spawnEnv>[0];
    expect(spawnEnv(services(() => ({ getSpawnEnv: () => ({ CLAUDE_CONFIG_DIR: '/cfg' }) })))).toEqual({ CLAUDE_CONFIG_DIR: '/cfg' });
    expect(spawnEnv(services(() => undefined))).toBe(process.env);
    expect(
      spawnEnv(
        services(() => ({
          getSpawnEnv: () => {
            throw new Error('not ready');
          },
        })),
      ),
    ).toBe(process.env);
  });

  it('old import paths still work (re-exports)', () => {
    expect(closeFlow.openModalIn).toBe(openModalIn);
    expect(lockFile.isPidAlive).toBe(isPidAlive);
  });
});
