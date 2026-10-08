// A fake `agy` executable for tests: implements `agy mcp list / add / remove / disable` like agy 1.3.0 (same table
// format and messages) against $HOME/.gemini/config/mcp_config.json, logs every invocation, and flags any two
// invocations that overlap in time (to prove the lock file serialises them). Behaviour knobs live in a control file
// next to the script so a test can change them between calls.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FakeAgyControl {
  /** Sleep inside every mcp command (widens race windows). */
  delayMs?: number;
  /** Subcommands that fail with exit 1 (e.g. `['list']`). */
  fail?: string[];
  /** stdout of a failing subcommand (default none). */
  failStdout?: string;
  /** stderr of a failing subcommand (default `Error: simulated failure of <sub>`). */
  failStderr?: string;
  /** Subcommands that hang until killed. */
  hang?: string[];
  /** Replaces the stdout of `mcp list`. */
  listOutput?: string;
}

export interface FakeCall {
  args: string[];
  pid: number;
  concurrent?: boolean;
}

export interface FakeAgy {
  /** Absolute path of the fake executable (named `agy`). */
  path: string;
  dir: string;
  configPath: string;
  control(c: FakeAgyControl): void;
  calls(): FakeCall[];
  /** Calls whose first two args are `mcp <sub>`. */
  mcpCalls(sub?: string): string[][];
  writeConfig(raw: string | object): string;
  readConfigRaw(): string | null;
  readConfig(): { mcpServers: Record<string, Record<string, unknown>> } | null;
}

const SCRIPT = String.raw`
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const home = process.env.HOME;
const cfgPath = path.join(home, '.gemini', 'config', 'mcp_config.json');
const control = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')); } catch { return {}; } })();
const args = process.argv.slice(2);
const log = (obj) => fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(obj) + '\n');
const busy = path.join(dir, 'busy');
let busyFd;
try { busyFd = fs.openSync(busy, 'wx'); } catch { log({ args, pid: process.pid, concurrent: true }); }
log({ args, pid: process.pid });
const exit = (code, out, err) => {
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  if (busyFd !== undefined) { fs.closeSync(busyFd); fs.unlinkSync(busy); }
  process.exit(code);
};
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
if (args[0] === '--version') exit(0, '1.3.0\n');
if (args[0] !== 'mcp') exit(1, '', 'Error: unexpected command\n');
const sub = args[1];
if ((control.hang || []).includes(sub)) { setInterval(() => {}, 1000); return; }
sleep(control.delayMs || 0);
if ((control.fail || []).includes(sub)) exit(1, control.failStdout || '', control.failStderr !== undefined ? control.failStderr : 'Error: simulated failure of ' + sub + '\n');
const load = () => {
  if (!fs.existsSync(cfgPath)) return { mcpServers: {} };
  const raw = fs.readFileSync(cfgPath, 'utf8');
  try { const c = JSON.parse(raw); if (!c.mcpServers) c.mcpServers = {}; return c; }
  catch (e) { exit(1, '', 'Error: failed to parse ' + cfgPath + ': failed to parse JSON config\n'); }
};
const save = (cfg) => { fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n'); };
const table = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => Array.from(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i] - Array.from(c).length + 2))).join('')).join('\n') + '\n';
};
if (sub === 'list') {
  if (control.listOutput !== undefined) exit(0, control.listOutput);
  const cfg = load();
  const names = Object.keys(cfg.mcpServers).sort();
  if (names.length === 0) exit(0, 'No MCP servers configured.\n');
  const rows = [['NAME', 'TYPE', 'STATUS', 'COMMAND/URL']];
  for (const n of names) {
    const s = cfg.mcpServers[n];
    const http = typeof s.serverUrl === 'string';
    rows.push([n, http ? 'http' : 'stdio', s.disabled ? 'disabled' : 'enabled', http ? s.serverUrl : [s.command, ...(s.args || [])].join(' ')]);
  }
  exit(0, table(rows));
}
if (sub === 'add') {
  const rest = args.slice(2);
  let i = 0;
  const valueFlags = ['-e', '--env', '-H', '--header', '-t', '--type'];
  while (i < rest.length && rest[i].startsWith('-') && rest[i] !== '--') { i += valueFlags.includes(rest[i]) ? 2 : 1; }
  const name = rest[i++];
  if (!name) exit(1, '', 'Error: missing <name>\n');
  if (rest[i] === '--') i++;
  else if (rest[i] && rest[i].startsWith('-')) exit(1, '', 'Error: flags must come before <name>\n');
  const command = rest[i++];
  if (!command) exit(1, '', 'Error: missing <commandOrUrl>\n');
  const cfg = load();
  cfg.mcpServers[name] = { args: rest.slice(i), command, disabled: false };
  save(cfg);
  exit(0, 'Added MCP server "' + name + '" (stdio)\n');
}
if (sub === 'remove' || sub === 'disable') {
  const name = args[2];
  const cfg = load();
  if (!cfg.mcpServers[name]) exit(1, '', 'Error: MCP server "' + name + '" not found\n');
  if (sub === 'remove') delete cfg.mcpServers[name]; else cfg.mcpServers[name].disabled = true;
  save(cfg);
  exit(0, (sub === 'remove' ? 'Removed' : 'Disabled') + ' MCP server "' + name + '"\n');
}
exit(1, '', 'Error: unknown mcp subcommand "' + sub + '"\n');
`;

/** Creates the fake in `dir` (an executable named `agy`); its config lives under the current (temp) HOME. */
export function createFakeAgy(dir: string): FakeAgy {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'agy');
  writeFileSync(path, `#!${process.execPath}\n${SCRIPT}`);
  chmodSync(path, 0o755);
  const configPath = join(homedir(), '.gemini', 'config', 'mcp_config.json');
  const readLog = (): FakeCall[] => {
    const file = join(dir, 'calls.log');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FakeCall);
  };
  return {
    path,
    dir,
    configPath,
    control(c) {
      writeFileSync(join(dir, 'control.json'), JSON.stringify(c));
    },
    calls: readLog,
    mcpCalls(sub) {
      return readLog()
        .filter((c) => !c.concurrent && c.args[0] === 'mcp' && (sub === undefined || c.args[1] === sub))
        .map((c) => c.args);
    },
    writeConfig(raw) {
      const text = typeof raw === 'string' ? raw : `${JSON.stringify(raw, null, 2)}\n`;
      mkdirSync(join(homedir(), '.gemini', 'config'), { recursive: true });
      writeFileSync(configPath, text);
      return text;
    },
    readConfigRaw() {
      return existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
    },
    readConfig() {
      return existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
    },
  };
}

/** A config with another server holding a (dummy) secret — must survive every operation byte for byte. */
export const DUMMY_SECRET = 'DUMMY-SECRET-sk-0123456789abcdef';
export function secretConfig(): { mcpServers: Record<string, Record<string, unknown>> } {
  return {
    mcpServers: {
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { CONTEXT7_API_KEY: DUMMY_SECRET } },
      remote: { serverUrl: 'https://example.com/mcp', headers: { Authorization: `Bearer ${DUMMY_SECRET}` } },
    },
  };
}
