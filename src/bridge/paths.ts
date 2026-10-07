import { normalizePath } from 'obsidian';

export type BridgeErrorCode = 'invalid-path' | 'invalid-argument' | 'not-found';

/** A tool-level failure (bad path, missing note …). The MCP layer turns it into an `isError` tool result. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: BridgeErrorCode,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/**
 * Validates a note path given by an MCP client and returns it vault-relative and normalized (D19, R8.7).
 * Rejects absolute paths (`/…`, `\…`, `~…`, `C:\…`, `file://…`), NUL bytes, and any `..` that would leave the vault
 * — also after Obsidian's `normalizePath` (backslashes become slashes, so `..\x` is caught too). Inner `.` / `..`
 * segments that stay inside the vault are resolved (`a/../b.md` → `b.md`).
 */
export function toVaultPath(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') throw new BridgeError('Path must be a non-empty vault-relative path, e.g. "Projects/idea.md".', 'invalid-path');
  if (input.includes('\0')) throw new BridgeError('Path contains a NUL character.', 'invalid-path');
  const raw = input.trim();
  if (/^[/\\~]/.test(raw) || /^[A-Za-z]:[/\\]/.test(raw) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    throw new BridgeError(`Absolute paths are not allowed: use a path relative to the vault root (got "${raw}").`, 'invalid-path');
  }
  const normalized = normalizePath(raw);
  const out: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) throw new BridgeError(`Path leaves the vault: "${raw}".`, 'invalid-path');
      out.pop();
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) throw new BridgeError(`Path does not name a note: "${raw}".`, 'invalid-path');
  return out.join('/');
}

/**
 * Lookup candidates for a validated path: as given, NFC and NFD (macOS file names may be stored decomposed,
 * e.g. Korean), and with `.md` appended when the path has no extension.
 */
export function pathCandidates(vaultPath: string): string[] {
  const forms = [vaultPath, vaultPath.normalize('NFC'), vaultPath.normalize('NFD')];
  const base = vaultPath.split('/').pop() ?? vaultPath;
  if (!/\.[^./]+$/.test(base)) forms.push(...forms.map((p) => `${p}.md`));
  return [...new Set(forms)];
}
