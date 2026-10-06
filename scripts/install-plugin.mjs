#!/usr/bin/env node
// Usage: npm run install-plugin -- <vault path> [--dist <dir>]
// Copies the built plugin (dist/) into <vault>/.obsidian/plugins/obsidian-ai-terminal/.
// Existing files there that are not part of the build (e.g. data.json with the settings) are left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ID = 'obsidian-ai-terminal';
export const REQUIRED_FILES = ['main.js', 'manifest.json', 'styles.css'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class InstallError extends Error {
  /** @param {'USAGE' | 'NO_VAULT' | 'NOT_A_VAULT' | 'NO_DIST' | 'PERMISSION' | 'COPY_FAILED'} code */
  constructor(code, message) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** True for macOS privacy (TCC) blocks and plain permission errors. */
export function isPermissionError(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return code === 'EPERM' || code === 'EACCES' || /operation not permitted|permission denied/i.test(message);
}

export function permissionHelp(target, distDir) {
  return [
    `macOS did not allow this terminal app to write to:`,
    `  ${target}`,
    ``,
    `Fix it in one of two ways:`,
    `  1. Give the terminal app access to the vault folder:`,
    `     System Settings › Privacy & Security › Files and Folders — allow your terminal app`,
    `     (Terminal, iTerm, IntelliJ IDEA, …) to access the folder (Documents, iCloud Drive, …),`,
    `     or add it under System Settings › Privacy & Security › Full Disk Access.`,
    `     Then quit and reopen the terminal app and run this command again.`,
    `  2. Or copy the files with Finder:`,
    `     open "${distDir}"   (opens the built plugin in Finder)`,
    `     Copy every file into ${target}`,
    `     (create the folder if needed; press Cmd+Shift+. in Finder to show the hidden .obsidian folder).`,
  ].join('\n');
}

/**
 * Copies `distDir` into `<vault>/.obsidian/plugins/obsidian-ai-terminal/`.
 * `fsp` can be replaced in tests (e.g. to simulate EPERM).
 * @returns {Promise<{ target: string, files: string[] }>}
 */
export async function installPlugin({ vault, distDir = path.join(ROOT, 'dist'), fsp = fs.promises }) {
  if (!vault) throw new InstallError('USAGE', 'Usage: npm run install-plugin -- <vault path>');
  const vaultPath = path.resolve(expandHome(vault));
  const configDir = path.join(vaultPath, '.obsidian');
  const target = path.join(configDir, 'plugins', PLUGIN_ID);

  const guard = async (what, fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof InstallError) throw err;
      if (isPermissionError(err)) {
        throw new InstallError('PERMISSION', `${what}: ${err.message}\n\n${permissionHelp(target, distDir)}`);
      }
      throw err;
    }
  };

  const missing = [];
  for (const f of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(distDir, f))) missing.push(f);
  }
  if (missing.length) throw new InstallError('NO_DIST', `${distDir} is missing ${missing.join(', ')} — run "npm run build" first.`);

  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  if (manifest.id !== PLUGIN_ID) throw new InstallError('NO_DIST', `dist/manifest.json has id "${manifest.id}", expected "${PLUGIN_ID}".`);

  await guard('Checking the vault', async () => {
    const st = await fsp.stat(vaultPath).catch((err) => {
      if (err.code === 'ENOENT') throw new InstallError('NO_VAULT', `Vault folder not found: ${vaultPath}`);
      throw err;
    });
    if (!st.isDirectory()) throw new InstallError('NO_VAULT', `Not a folder: ${vaultPath}`);
    const cst = await fsp.stat(configDir).catch((err) => {
      if (err.code === 'ENOENT') {
        throw new InstallError('NOT_A_VAULT', `${vaultPath} has no .obsidian folder — open it as a vault in Obsidian once, then try again.`);
      }
      throw err;
    });
    if (!cst.isDirectory()) throw new InstallError('NOT_A_VAULT', `${configDir} is not a folder.`);
  });

  const files = [];
  await guard('Copying the plugin', async () => {
    await fsp.mkdir(target, { recursive: true });
    const copyDir = async (from, to, rel) => {
      for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dest = path.join(to, entry.name);
        if (entry.isDirectory()) {
          await fsp.mkdir(dest, { recursive: true });
          await copyDir(src, dest, path.join(rel, entry.name));
        } else if (entry.isFile()) {
          await fsp.copyFile(src, dest);
          files.push(path.join(rel, entry.name));
        }
      }
    };
    await copyDir(distDir, target, '');
  });
  return { target, files: files.sort() };
}

/**
 * @param {string[]} [argv]
 * @param {{ log: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} [out]
 * @returns {Promise<number>} exit code: 0 ok, 1 usage / validation error, 2 permission block
 */
export async function main(argv = process.argv.slice(2), out = console) {
  let vault;
  let distDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') distDir = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      out.log('Usage: npm run install-plugin -- <vault path> [--dist <dir>]');
      return 0;
    } else vault = argv[i];
  }
  try {
    const { target, files } = await installPlugin({ vault, ...(distDir ? { distDir: path.resolve(distDir) } : {}) });
    out.log(`Installed ${files.length} files into ${target}:`);
    for (const f of files) out.log(`  ${f}`);
    out.log('');
    out.log('Next: in Obsidian open Settings › Community plugins, turn off Restricted mode if needed, and enable "AI Terminal"');
    out.log('(if it was already enabled, turn it off and on again to load the new version).');
    return 0;
  } catch (err) {
    if (err instanceof InstallError) {
      out.error(err.message);
      return err.code === 'PERMISSION' ? 2 : 1;
    }
    out.error(`Install failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
