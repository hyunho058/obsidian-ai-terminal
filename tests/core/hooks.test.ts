import { describe, expect, it, vi } from 'vitest';
import { SessionEvents, TypedEmitter } from '../../src/core/events';
import { KeyboardHooks } from '../../src/core/keyboard';
import { BridgeRouteRegistry } from '../../src/core/routes';
import type { TerminalPanelHandle } from '../../src/core/types';

const panel = { panelId: 'p', profile: 'agy' } as unknown as TerminalPanelHandle;
const key = (k: string) => ({ key: k, type: 'keydown' }) as KeyboardEvent;

describe('KeyboardHooks', () => {
  it('dispatches in order until a handler consumes the event', () => {
    const hooks = new KeyboardHooks();
    const calls: string[] = [];
    hooks.onKey(() => (calls.push('a'), false));
    hooks.onKey((ev) => (calls.push('b'), ev.key === 'Enter'));
    hooks.onKey(() => (calls.push('c'), true));
    expect(hooks.dispatchKey(key('Enter'), panel)).toBe(true);
    expect(calls).toEqual(['a', 'b']);
  });

  it('treats a throwing handler as not consumed', () => {
    const report = vi.fn();
    const hooks = new KeyboardHooks(report);
    hooks.onKey(() => {
      throw new Error('x');
    });
    expect(hooks.dispatchKey(key('a'), panel)).toBe(false);
    expect(report).toHaveBeenCalled();
  });

  it('keeps Enter interceptors in order and supports removal', () => {
    const hooks = new KeyboardHooks();
    const a = async () => {};
    const b = () => {};
    hooks.onEnterIntercept(a);
    const offB = hooks.onEnterIntercept(b);
    expect(hooks.enterInterceptors()).toEqual([a, b]);
    offB();
    expect(hooks.enterInterceptors()).toEqual([a]);
  });
});

describe('BridgeRouteRegistry', () => {
  it('matches method + exact path, ignoring the query string', () => {
    const routes = new BridgeRouteRegistry();
    const h = vi.fn();
    routes.addRoute('POST', '/snapshot', h);
    expect(routes.match('POST', '/snapshot?x=1')).toBe(h);
    expect(routes.match('post', '/snapshot')).toBe(h);
    expect(routes.match('GET', '/snapshot')).toBeUndefined();
    expect(routes.match('POST', '/snapshot/x')).toBeUndefined();
    expect(routes.list()).toEqual([{ method: 'POST', path: '/snapshot' }]);
  });

  it('rejects duplicates and bad paths; disposer removes', () => {
    const routes = new BridgeRouteRegistry();
    const off = routes.addRoute('GET', '/a', () => {});
    expect(() => routes.addRoute('GET', '/a', () => {})).toThrow(/already registered/);
    expect(() => routes.addRoute('GET', 'a', () => {})).toThrow(/start with/);
    off();
    expect(routes.match('GET', '/a')).toBeUndefined();
  });
});

describe('TypedEmitter / SessionEvents', () => {
  it('delivers typed payloads and isolates throwing listeners', () => {
    const report = vi.fn();
    const ev = new SessionEvents(report);
    const got: unknown[] = [];
    ev.on('session:exited', () => {
      throw new Error('bad listener');
    });
    const off = ev.on('session:exited', (p) => got.push(p.exitCode));
    ev.emit('session:exited', { panelId: 'p', profile: 'claude', exitCode: 3, runtimeMs: 10 });
    off();
    ev.emit('session:exited', { panelId: 'p', profile: 'claude', exitCode: 4, runtimeMs: 10 });
    expect(got).toEqual([3]);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('runs beforeSpawn hooks sequentially, awaiting each, and never throws', async () => {
    const report = vi.fn();
    const ev = new SessionEvents(report);
    const order: string[] = [];
    ev.beforeSpawn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    });
    ev.beforeSpawn(() => {
      throw new Error('hook failed');
    });
    ev.beforeSpawn((ctx) => {
      order.push(`fast:${ctx.phase}`);
      ctx.print('[hello]');
    });
    const print = vi.fn();
    await ev.runBeforeSpawn({ panelId: 'p', profile: 'claude', phase: 'restore', vaultPath: '/v', print });
    expect(order).toEqual(['slow', 'fast:restore']);
    expect(print).toHaveBeenCalledWith('[hello]');
    expect(report).toHaveBeenCalledWith('beforeSpawn hook failed', expect.any(Error));
  });

  it('generic emitter works with any event map', () => {
    const em = new TypedEmitter<{ ping: number }>();
    const fn = vi.fn();
    em.on('ping', fn);
    em.emit('ping', 1);
    em.clear();
    em.emit('ping', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
