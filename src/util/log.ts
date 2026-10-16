import { Notice } from 'obsidian';
import { inspect } from 'util';

export const REDACTED = '[REDACTED]';
/** Shorter values are ignored by `registerSecret` (they would redact ordinary words). */
export const MIN_SECRET_LENGTH = 6;

const secrets = new Map<string, number>();

/**
 * Registers a secret (bridge token, auth token …) so it is replaced by `[REDACTED]` in every log line and
 * Notice. Also redacts its URL-encoded form. Returns a function that unregisters it.
 */
export function registerSecret(value: string | null | undefined): () => void {
  if (!value || value.length < MIN_SECRET_LENGTH) return () => {};
  const forms = new Set([value, encodeURIComponent(value)]);
  for (const f of forms) secrets.set(f, (secrets.get(f) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const f of forms) {
      const n = (secrets.get(f) ?? 1) - 1;
      if (n <= 0) secrets.delete(f);
      else secrets.set(f, n);
    }
  };
}

/** Replaces every registered secret in `text`. */
export function redact(text: string): string {
  if (secrets.size === 0 || !text) return text;
  let out = text;
  for (const s of [...secrets.keys()].sort((a, b) => b.length - a.length)) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

/** Converts any log argument to a redacted string (objects and errors are inspected first). */
export function redactValue(value: unknown): string {
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) return redact(value.stack ?? `${value.name}: ${value.message}`);
  return redact(inspect(value, { depth: 4, breakLength: Infinity }));
}

/** For tests. */
export function clearSecrets(): void {
  secrets.clear();
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** A logger whose lines are prefixed `[AI Terminal:<scope>]`. */
  child(scope: string): Logger;
}

export interface LogSink {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

let debugEnabled = readDebugFlag();

/** Debug lines are dropped unless enabled (or `localStorage['obsidian-ai-terminal:debug'] = '1'`). */
export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

function readDebugFlag(): boolean {
  try {
    return window.localStorage?.getItem('obsidian-ai-terminal:debug') === '1';
  } catch {
    return false;
  }
}

export function createLogger(scope?: string, sink: LogSink = console): Logger {
  const prefix = scope ? `[AI Terminal:${scope}]` : '[AI Terminal]';
  const write = (level: LogLevel, args: unknown[]): void => {
    if (level === 'debug' && !debugEnabled) return;
    sink[level](prefix, ...args.map(redactValue));
  };
  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    child: (child) => createLogger(scope ? `${scope}:${child}` : child, sink),
  };
}

/** Shows an Obsidian Notice with secrets redacted. `timeoutMs` 0 keeps it until clicked. */
export function notice(message: string, timeoutMs?: number): Notice {
  return new Notice(redact(message), timeoutMs);
}
