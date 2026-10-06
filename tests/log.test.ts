import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets, createLogger, notice, redact, redactValue, registerSecret, REDACTED, type LogSink } from '../src/util/log';
import { Notice } from './mocks/obsidian';

const TOKEN = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';

function sink(): LogSink & { lines: Array<{ level: string; text: string }> } {
  const lines: Array<{ level: string; text: string }> = [];
  const mk = (level: string) => (...a: unknown[]) => lines.push({ level, text: a.join(' ') });
  return { lines, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
}

afterEach(() => {
  clearSecrets();
  Notice.clear();
});

describe('redaction', () => {
  it('replaces registered secrets everywhere in a string', () => {
    registerSecret(TOKEN);
    expect(redact(`Bearer ${TOKEN} and again ${TOKEN}`)).toBe(`Bearer ${REDACTED} and again ${REDACTED}`);
  });

  it('also redacts the URL-encoded form', () => {
    const secret = 'abc/def+ghi=';
    registerSecret(secret);
    expect(redact(`?t=${encodeURIComponent(secret)}`)).toBe(`?t=${REDACTED}`);
  });

  it('ignores empty and very short values', () => {
    registerSecret('');
    registerSecret(undefined);
    registerSecret('ab');
    expect(redact('ab abc')).toBe('ab abc');
  });

  it('unregister stops redacting (reference counted)', () => {
    const off1 = registerSecret(TOKEN);
    const off2 = registerSecret(TOKEN);
    off1();
    off1();
    expect(redact(TOKEN)).toBe(REDACTED);
    off2();
    expect(redact(TOKEN)).toBe(TOKEN);
  });

  it('redacts inside objects and errors', () => {
    registerSecret(TOKEN);
    expect(redactValue({ headers: { Authorization: `Bearer ${TOKEN}` } })).not.toContain(TOKEN);
    const err = new Error(`connect failed with token ${TOKEN}`);
    const s = redactValue(err);
    expect(s).toContain('connect failed');
    expect(s).not.toContain(TOKEN);
    expect(redactValue(42)).toBe('42');
  });
});

describe('logger', () => {
  it('prefixes, scopes and redacts every argument', () => {
    registerSecret(TOKEN);
    const out = sink();
    const log = createLogger(undefined, out).child('bridge');
    log.info('listening', { url: `http://127.0.0.1:1234/mcp?token=${TOKEN}` });
    log.error(new Error(`bad ${TOKEN}`));
    log.warn('plain');
    expect(out.lines[0]?.text).toMatch(/^\[AI Terminal:bridge\] listening/);
    expect(out.lines.map((l) => l.text).join('\n')).not.toContain(TOKEN);
    expect(out.lines.map((l) => l.level)).toEqual(['info', 'error', 'warn']);
    expect(createLogger('a', out).child('b')).toBeDefined();
  });

  it('drops debug lines unless enabled', async () => {
    const { setDebugLogging } = await import('../src/util/log');
    const out = sink();
    const log = createLogger('x', out);
    log.debug('hidden');
    setDebugLogging(true);
    log.debug('shown');
    setDebugLogging(false);
    expect(out.lines.map((l) => l.text)).toEqual(['[AI Terminal:x] shown']);
  });

  it('notice() redacts the Notice text', () => {
    registerSecret(TOKEN);
    notice(`Bridge token ${TOKEN}`, 0);
    expect(Notice.shown[0]?.message).toBe(`Bridge token ${REDACTED}`);
    expect(Notice.shown[0]?.duration).toBe(0);
  });
});
