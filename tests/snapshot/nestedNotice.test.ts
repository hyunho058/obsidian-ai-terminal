// R12.14 end-to-end: a vault folder with its own .git is reported by one Notice, once per Obsidian session — also when
// the plugin is reloaded on the same vault (the "reported" set lives on the window's global object, keyed by store).
import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridgeModule } from '../../src/bridge/index';
import { createSnapshotModule } from '../../src/snapshot/index';
import { Notice } from '../mocks/obsidian';
import { fakePanel, makeVault, REAL_GIT, sleep, startRuntime, storeGit, writeFile } from './helpers';

const TOKEN = 'nested-notice-test-token-0123456789';

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const runtimes: Runtime[] = [];

beforeEach(() => Notice.clear());
afterEach(() => {
  for (const rt of runtimes.splice(0)) if (!rt.ctx.unloading) rt.runtime.unload();
});

/** One plugin load over `vault`: the bridge (for `POST /snapshot`) + the snapshot module, snapshots on, one Claude panel. */
async function load(vault: string): Promise<Runtime> {
  const rt = await startRuntime({
    vault,
    modules: [createBridgeModule({ token: TOKEN }), createSnapshotModule({ checkGit: async () => ({ ok: true, version: 'git version test' }) })],
    panels: [fakePanel('claude', 'panel-1')],
    data: { snapshots: { enabled: true } },
  });
  runtimes.push(rt);
  return rt;
}

/** What `snapshot_hook.py` does before a Claude prompt. */
function postSnapshot(rt: Runtime, prompt: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = `${rt.ctx.services.require('bridgeServer').baseUrl}/snapshot`;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ panelId: 'panel-1', prompt, ai: 'claude' }));
  });
}

function nestedNotices(): Notice[] {
  return Notice.shown.filter((n) => /separate git repositor/.test(n.message));
}

async function settle(rt: Runtime): Promise<void> {
  await rt.ctx.services.require('snapshots').whenIdle();
  await sleep(300);
}

describe('R12.14: nested git repositories are reported once', () => {
  it('one Notice names the folder; more snapshots and a plugin reload on the same vault do not repeat it', async () => {
    const vault = makeVault({ 'a.md': 'A', 'repo/n.md': 'n' });
    execFileSync(REAL_GIT, ['init', '-q'], { cwd: `${vault}/repo` });

    const first = await load(vault);
    const snapshots = first.ctx.services.require('snapshots');
    const r1 = await postSnapshot(first, 'first prompt');
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ status: 'committed' });
    await settle(first);
    expect(nestedNotices()).toHaveLength(1);
    expect(nestedNotices()[0]!.message).toBe(
      "AI Terminal: this folder is a separate git repository, so AI session snapshots can't include its notes: repo",
    );
    // The folder's notes really are not in the snapshot; the rest of the vault is.
    const tree = storeGit(snapshots.storePath, vault, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
    expect(tree).toContain('a.md');
    expect(tree).not.toContain('repo/n.md');

    // A second snapshot in the same plugin load.
    writeFile(vault, 'a.md', 'A2');
    snapshots.markChanged('test');
    expect((await postSnapshot(first, 'second prompt')).json).toMatchObject({ status: 'committed' });
    await settle(first);
    expect(nestedNotices()).toHaveLength(1);

    // Plugin reload (disable / enable, or a plugin update) on the same vault, same Obsidian session.
    const storePath = snapshots.storePath;
    first.runtime.unload();
    const second = await load(vault);
    expect(second.ctx.services.require('snapshots').storePath).toBe(storePath);
    writeFile(vault, 'a.md', 'A3');
    second.ctx.services.require('snapshots').markChanged('test');
    expect((await postSnapshot(second, 'third prompt')).json).toMatchObject({ status: 'committed' });
    await settle(second);
    expect(nestedNotices()).toHaveLength(1);
    expect(Notice.shown.filter((n) => n.message.includes('repo'))).toHaveLength(1);
  });
});
