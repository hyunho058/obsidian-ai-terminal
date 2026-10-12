// The Python helpers, bundled into main.js as text (esbuild's `.py` text loader; vitest.config.ts does the same).
// Obsidian installs only main.js, manifest.json and styles.css from a release, so `writeBundledScripts` puts these
// into the plugin folder on load.
import mcpShim from '../bridge/mcp_shim.py';
import ptyBridge from '../pty/pty_bridge.py';
import snapshotHook from '../snapshot/snapshot_hook.py';

/** File name → content of every shipped `.py` under src/ (tests/build.test.ts checks that none is missing). */
export const BUNDLED_SCRIPTS: Readonly<Record<string, string>> = {
  'mcp_shim.py': mcpShim,
  'pty_bridge.py': ptyBridge,
  'snapshot_hook.py': snapshotHook,
};
