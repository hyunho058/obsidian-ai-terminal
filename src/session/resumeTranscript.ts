import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Lines longer than this are skipped unparsed (a pasted image can make one transcript line megabytes long). */
export const TRANSCRIPT_MAX_LINE_BYTES = 256 * 1024;
/** Never read more than this much of one transcript; the first `cwd` is normally within the first few KB. */
export const TRANSCRIPT_MAX_SCAN_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * Claude Code's config folder: `$CLAUDE_CONFIG_DIR` when the spawn environment sets it to an absolute path
 * (Claude then keeps its transcripts there), else `~/.claude`.
 */
export function claudeConfigDir(env?: Readonly<Record<string, string | undefined>>): string {
  const custom = env?.CLAUDE_CONFIG_DIR?.trim();
  if (custom && path.isAbsolute(custom)) return custom;
  return path.join(os.homedir(), '.claude');
}

/**
 * Every `<configDir>/projects/<any folder>/<sessionId>.jsonl` that is a file. The project folder name is not
 * computed from the vault path (D22: Claude's escaping rules are undocumented) — every folder is checked.
 */
export async function findTranscriptFiles(configDir: string, sessionId: string): Promise<string[]> {
  const projects = path.join(configDir, 'projects');
  let entries: string[];
  try {
    entries = await fsp.readdir(projects);
  } catch {
    return [];
  }
  const name = `${sessionId}.jsonl`;
  const found = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(projects, entry, name);
      try {
        return (await fsp.stat(file)).isFile() ? file : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((f): f is string => f !== null).sort();
}

/**
 * `realpath` + Unicode NFC, without a trailing separator. A path that no longer exists (folder deleted or moved)
 * resolves its nearest existing ancestor and keeps the rest as written, so a symlinked prefix still compares equal.
 */
export async function canonicalPath(p: string): Promise<string> {
  const resolved = path.resolve(p);
  let head = resolved;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fsp.realpath(head);
      return trimSeparator(path.join(real, ...rest).normalize('NFC'));
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return trimSeparator(resolved.normalize('NFC'));
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

function trimSeparator(p: string): string {
  return p.length > 1 && p.endsWith(path.sep) ? p.slice(0, -1) : p;
}

/** True if `child` is `parent` or inside it (both already canonical). */
export function isSameOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

export interface TranscriptScan {
  /** The first `cwd` recorded in the transcript, as written. */
  firstCwd?: string;
  /** A recorded `cwd` (the first one or any later one) is the vault or inside it. */
  inVault: boolean;
  /** The whole file was read (not cut short by a match or the byte cap). */
  complete: boolean;
  bytesRead: number;
}

export interface ScanOptions {
  maxScanBytes?: number;
  maxLineBytes?: number;
}

/**
 * Streams a Claude Code transcript (JSON lines) until a recorded `cwd` is found inside `vaultCanonical`
 * (a `canonicalPath`), reading at most `maxScanBytes`. Lines that are not JSON objects with a string `cwd` are
 * ignored; lines longer than `maxLineBytes` are skipped without being buffered. Throws only on I/O errors.
 */
export async function scanTranscript(file: string, vaultCanonical: string, options: ScanOptions = {}): Promise<TranscriptScan> {
  const maxScan = options.maxScanBytes ?? TRANSCRIPT_MAX_SCAN_BYTES;
  const maxLine = options.maxLineBytes ?? TRANSCRIPT_MAX_LINE_BYTES;
  const result: TranscriptScan = { inVault: false, complete: false, bytesRead: 0 };
  const checked = new Map<string, boolean>();

  /** Returns true when the scan can stop (a cwd inside the vault was found). */
  const consider = async (line: Buffer): Promise<boolean> => {
    if (line.indexOf('"cwd"') === -1) return false;
    const cwd = recordedCwd(line.toString('utf8'));
    if (cwd === undefined) return false;
    if (result.firstCwd === undefined) result.firstCwd = cwd;
    let inside = checked.get(cwd);
    if (inside === undefined) {
      inside = isSameOrInside(await canonicalPath(cwd), vaultCanonical);
      checked.set(cwd, inside);
    }
    if (inside) result.inVault = true;
    return inside;
  };

  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    for (;;) {
      const want = Math.min(CHUNK_BYTES, maxScan - result.bytesRead);
      if (want <= 0) return result;
      const { bytesRead: n } = await fh.read(buf, 0, want, null);
      if (n === 0) break;
      result.bytesRead += n;
      const chunk = buf.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(NEWLINE, start);
        if (nl === -1) {
          if (!skipping) {
            pending.push(Buffer.from(chunk.subarray(start)));
            pendingBytes += n - start;
            if (pendingBytes > maxLine) {
              pending = [];
              pendingBytes = 0;
              skipping = true;
            }
          }
          break;
        }
        if (!skipping && pendingBytes + (nl - start) <= maxLine) {
          const line = pending.length ? Buffer.concat([...pending, chunk.subarray(start, nl)]) : chunk.subarray(start, nl);
          if (await consider(line)) return result;
        }
        pending = [];
        pendingBytes = 0;
        skipping = false;
        start = nl + 1;
      }
    }
    if (!skipping && pendingBytes > 0 && (await consider(Buffer.concat(pending)))) return result;
    result.complete = true;
    return result;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

function recordedCwd(line: string): string | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const cwd = (entry as { cwd?: unknown }).cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

/**
 * - `match`: a transcript records a `cwd` that is the vault or inside it → `--resume`.
 * - `elsewhere`: transcripts exist and record a `cwd`, none inside the vault → new conversation (R5.7).
 * - `missing`: no transcript file → `--session-id` with the same id (R5.6).
 * - `empty`: transcript files exist but were read to the end without any recorded `cwd` (empty, metadata only or
 *   corrupt) — nothing that could be resumed.
 * - `unreadable`: a transcript could not be read (I/O error) or no `cwd` was found within the byte cap.
 */
export type TranscriptStatus = 'match' | 'elsewhere' | 'missing' | 'empty' | 'unreadable';

export interface TranscriptLookup {
  status: TranscriptStatus;
  files: string[];
  /** First recorded `cwd` of the transcript the status is based on, when one was found. */
  firstCwd?: string;
  /** I/O errors met while reading, for the debug log. */
  errors: string[];
}

export interface LookupOptions extends ScanOptions {
  configDir: string;
}

/** D22: finds `<configDir>/projects/*\/<sessionId>.jsonl` and checks its recorded `cwd` against the vault. */
export async function lookupClaudeTranscript(sessionId: string, vaultPath: string, options: LookupOptions): Promise<TranscriptLookup> {
  const files = await findTranscriptFiles(options.configDir, sessionId);
  if (files.length === 0) return { status: 'missing', files, errors: [] };
  const vault = await canonicalPath(vaultPath);
  const errors: string[] = [];
  let firstCwd: string | undefined;
  let incomplete = false;
  for (const file of files) {
    let scan: TranscriptScan;
    try {
      scan = await scanTranscript(file, vault, options);
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      incomplete = true;
      continue;
    }
    if (scan.inVault) return withCwd({ status: 'match', files, errors }, scan.firstCwd);
    firstCwd ??= scan.firstCwd;
    if (scan.firstCwd === undefined && !scan.complete) incomplete = true;
  }
  if (firstCwd !== undefined) return withCwd({ status: 'elsewhere', files, errors }, firstCwd);
  return { status: incomplete ? 'unreadable' : 'empty', files, errors };
}

function withCwd(lookup: TranscriptLookup, cwd: string | undefined): TranscriptLookup {
  if (cwd !== undefined) lookup.firstCwd = cwd;
  return lookup;
}
