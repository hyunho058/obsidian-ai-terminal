import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPidAlive } from '../util/process';

export { isPidAlive };

/** `ideName` in our lock files; also how stale-file cleanup recognises them (D29). */
export const IDE_NAME = 'Obsidian';

/**
 * Contents of `~/.claude/ide/<port>.lock` as Claude Code 2.1.29x reads it: the port comes from the file name;
 * `transport: "ws"` selects `ws://127.0.0.1:<port>`; `authToken` is sent as `X-Claude-Code-Ide-Authorization`;
 * `workspaceFolders` must contain Claude's cwd unless `CLAUDE_CODE_SSE_PORT` names the port; Claude deletes the file
 * itself once `pid` is dead.
 */
export interface IdeLockContent {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: 'ws';
  authToken: string;
}

/**
 * Claude Code scans `~/.claude/ide` always — also when `$CLAUDE_CONFIG_DIR` is set (it then scans
 * `$CLAUDE_CONFIG_DIR/ide` as well; verified with 2.1.292) — so lock files go there regardless of the config dir.
 */
export function ideLockDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'ide');
}

/** The vault path, plus its real path when that differs (Claude compares workspace folders against its real cwd). */
export function workspaceFoldersFor(vaultPath: string): string[] {
  const folders = [vaultPath];
  try {
    const real = fs.realpathSync(vaultPath);
    if (real !== vaultPath) folders.push(real);
  } catch {
    // vault path not resolvable: keep it as is
  }
  return folders;
}

/**
 * Writes `<dir>/<port>.lock` atomically with mode 0600 (temp file in the same folder + rename; the temp name does not
 * end in `.lock`, so Claude never reads a half-written file). Creates the folder (0700) if needed. Returns the path.
 */
export function writeLockFile(dir: string, port: number, content: IdeLockContent): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${port}.lock`);
  const tmp = path.join(dir, `.${port}.lock.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, JSON.stringify(content));
  } catch (err) {
    fs.closeSync(fd);
    rmQuiet(tmp);
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    rmQuiet(tmp);
    throw err;
  }
  return file;
}

/**
 * Synchronously removes `file` if it is still ours (same `authToken`) — safe during plugin unload, which Obsidian does
 * not await (R10.9). A missing file is fine. Returns true if a file was removed.
 */
export function removeLockFile(file: string, authToken: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const parsed = parseLock(raw);
  if (!parsed || parsed.authToken !== authToken) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export interface StaleCleanupResult {
  removed: string[];
  kept: string[];
}

/**
 * D29 / R10.7: deletes `<dir>/*.lock` files whose `ideName` is "Obsidian" and whose `pid` is dead. Other IDEs' files,
 * unparsable files, files without a valid pid, symlinks and folders are never touched.
 */
export async function cleanStaleLockFiles(dir: string, isAlive: (pid: number) => boolean = isPidAlive): Promise<StaleCleanupResult> {
  const result: StaleCleanupResult = { removed: [], kept: [] };
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return result;
  }
  for (const name of names.filter((n) => n.endsWith('.lock')).sort()) {
    const file = path.join(dir, name);
    try {
      const st = await fs.promises.lstat(file);
      if (!st.isFile()) {
        result.kept.push(file);
        continue;
      }
      const lock = parseLock(await fs.promises.readFile(file, 'utf8'));
      const pid = lock?.pid;
      if (!lock || lock.ideName !== IDE_NAME || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || isAlive(pid)) {
        result.kept.push(file);
        continue;
      }
      await fs.promises.unlink(file);
      result.removed.push(file);
    } catch {
      result.kept.push(file);
    }
  }
  return result;
}

function parseLock(raw: string): Partial<Record<keyof IdeLockContent, unknown>> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function rmQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}
