// Claude Code transcript fixtures inside the per-file temp HOME (tests/setup.ts) — never the real ~/.claude.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function claudeHome(): string {
  return join(homedir(), '.claude');
}

export function resetClaudeHome(): void {
  rmSync(claudeHome(), { recursive: true, force: true });
}

export function tempDir(prefix = 'resume-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Shaped like Claude Code 2.1.x transcript lines (metadata lines carry no `cwd`). */
export function metaLines(sessionId: string): object[] {
  return [
    { type: 'mode', mode: 'default', sessionId },
    { type: 'permission-mode', permissionMode: 'default', sessionId },
  ];
}

export function entry(sessionId: string, cwd: string, type = 'user'): object {
  return {
    parentUuid: null,
    isSidechain: false,
    type,
    message: { role: 'user', content: 'hello' },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '2.1.291',
    gitBranch: '',
  };
}

/** Writes `<configDir>/projects/<folder>/<sessionId>.jsonl`; strings are written as raw lines. */
export function writeTranscript(
  sessionId: string,
  lines: Array<object | string>,
  options: { folder?: string; configDir?: string; trailingNewline?: boolean } = {},
): string {
  const dir = join(options.configDir ?? claudeHome(), 'projects', options.folder ?? '-some-project');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  writeFileSync(file, options.trailingNewline === false ? body : `${body}\n`);
  return file;
}

/** A normal transcript whose first recorded cwd is `cwd`, optionally followed by entries in `later` folders. */
export function conversation(sessionId: string, cwd: string, later: string[] = [], options: { folder?: string; configDir?: string } = {}): string {
  return writeTranscript(
    sessionId,
    [...metaLines(sessionId), entry(sessionId, cwd, 'system'), { type: 'file-history-snapshot', messageId: 'm', snapshot: {} }, entry(sessionId, cwd), ...later.map((c) => entry(sessionId, c))],
    options,
  );
}
