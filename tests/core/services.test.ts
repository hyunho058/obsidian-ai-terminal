import { describe, expect, it } from 'vitest';
import { ServiceRegistry, ServiceTimeoutError } from '../../src/core/services';

interface Clock {
  now(): number;
}

declare module '../../src/core/services' {
  interface ServiceMap {
    testClock: Clock;
    testOther: string;
  }
}

describe('ServiceRegistry', () => {
  it('provides and gets typed services', () => {
    const reg = new ServiceRegistry();
    expect(reg.get('testClock')).toBeUndefined();
    expect(reg.has('testClock')).toBe(false);
    const clock: Clock = { now: () => 42 };
    reg.provide('testClock', clock);
    expect(reg.get('testClock')?.now()).toBe(42);
    expect(reg.require('testClock')).toBe(clock);
    expect(reg.has('testClock')).toBe(true);
  });

  it('rejects a second provider for the same key', () => {
    const reg = new ServiceRegistry();
    reg.provide('testOther', 'a');
    expect(() => reg.provide('testOther', 'b')).toThrow(/already provided/);
  });

  it('require throws when missing', () => {
    expect(() => new ServiceRegistry().require('testOther')).toThrow(/not available/);
  });

  it('disposer removes only its own implementation', () => {
    const reg = new ServiceRegistry();
    const dispose = reg.provide('testOther', 'a');
    dispose();
    expect(reg.get('testOther')).toBeUndefined();
    reg.provide('testOther', 'b');
    dispose();
    expect(reg.get('testOther')).toBe('b');
  });

  it('whenAvailable resolves immediately or once provided', async () => {
    const reg = new ServiceRegistry();
    const later = reg.whenAvailable('testOther');
    reg.provide('testOther', 'x');
    await expect(later).resolves.toBe('x');
    await expect(reg.whenAvailable('testOther')).resolves.toBe('x');
  });

  it('whenAvailable rejects after its timeout', async () => {
    const reg = new ServiceRegistry();
    await expect(reg.whenAvailable('testClock', 10)).rejects.toBeInstanceOf(ServiceTimeoutError);
  });
});
