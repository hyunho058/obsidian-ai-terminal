// @vitest-environment happy-dom
// The restore command (R1.1, R13): registration, the unavailable Notice, opening the modal, unload.
import type { App } from 'obsidian';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureModule } from '../../src/core/types';
import AiTerminalPlugin from '../../src/main';
import { createSnapshotModule } from '../../src/snapshot/index';
import { RESTORE_COMMAND_ID, RESTORE_COMMAND_NAME } from '../../src/snapshot/restore';
import { RestoreModal } from '../../src/snapshot/restoreModal';
import { createRestoreModule, unavailableMessage } from '../../src/snapshot/restoreModule';
import { createManifest, createMockApp, Modal, Notice } from '../mocks/obsidian';
import { startRuntime } from '../snapshot/helpers';
import { FakeSnapshots, makeVault } from './helpers';

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const runtimes: Runtime[] = [];

afterEach(() => {
  for (const m of [...Modal.open]) m.close();
  for (const rt of runtimes.splice(0)) rt.runtime.unload();
  Notice.clear();
});

const COMMAND = `obsidian-ai-terminal:${RESTORE_COMMAND_ID}`;

async function load(modules: FeatureModule[], data: unknown = { snapshots: { enabled: true } }) {
  const rt = await startRuntime({ vault: makeVault({ 'note.md': 'hello' }), modules, data });
  runtimes.push(rt);
  const command = rt.plugin.commands.find((c) => c.id === COMMAND);
  return { ...rt, command };
}

function fakeSnapshotsModule(fake: FakeSnapshots): FeatureModule {
  return { id: 'fake-snapshots', register: (ctx) => void ctx.services.provide('snapshots', fake) };
}

describe('restore command', () => {
  it('is registered as "Restore notes from before an AI session…"', async () => {
    const { command } = await load([createRestoreModule()]);
    expect(command).toBeDefined();
    expect(command!.name).toBe(RESTORE_COMMAND_NAME);
    expect(RESTORE_COMMAND_NAME).toBe('Restore notes from before an AI session…');
    expect(command!.icon).toBe('history');
  });

  it('shows a Notice with the reason when git is not available, and opens nothing', async () => {
    const reason = 'xcrun: error: invalid active developer path';
    const { command, ctx } = await load([createSnapshotModule({ checkGit: async () => ({ ok: false, reason }) }), createRestoreModule()], {
      snapshots: { enabled: false },
    });
    expect(ctx.services.require('snapshots').isAvailable()).toBe(false);
    Notice.clear();
    command!.callback!();
    expect(Notice.shown.map((n) => n.message)).toEqual([unavailableMessage(reason)]);
    expect(Notice.shown[0]!.message).toBe(`AI Terminal: notes can't be restored — git is not available: ${reason}.`);
    expect(Modal.open).toHaveLength(0);
  });

  it('shows a Notice when the snapshot service is missing', async () => {
    const { command } = await load([createRestoreModule()]);
    command!.callback!();
    expect(Notice.shown.map((n) => n.message)).toEqual([expect.stringMatching(/notes can't be restored — the snapshot feature did not start/)]);
    expect(Modal.open).toHaveLength(0);
  });

  it('opens the modal while the git check is still running (list() waits for it)', async () => {
    const fake = new FakeSnapshots();
    fake.available = false;
    const { command } = await load([fakeSnapshotsModule(fake), createRestoreModule()]);
    command!.callback!();
    expect(Modal.open).toHaveLength(1);
    expect(Modal.open[0]).toBeInstanceOf(RestoreModal);
    await vi.waitFor(() => expect(fake.list).toHaveBeenCalled());
  });

  it('opens the modal over the real snapshot service and lists the first snapshot; unload closes it', async () => {
    const { command, ctx, runtime } = await load([createSnapshotModule({ checkGit: async () => ({ ok: true, version: 'git version test' }) }), createRestoreModule()]);
    const svc = ctx.services.require('snapshots');
    expect((await svc.snapshotNow({ kind: 'first' })).status).toBe('committed');
    command!.callback!();
    const modal = Modal.open[0] as unknown as RestoreModal;
    expect(modal).toBeInstanceOf(RestoreModal);
    const content = (modal as unknown as Modal).contentEl as HTMLElement;
    await vi.waitFor(() => expect(content.querySelector('.ai-terminal-restore-what')?.textContent).toBe('first snapshot'));
    await vi.waitFor(() => expect(content.querySelector('.ai-terminal-restore-count')?.textContent).toBe('no changes since'));
    runtime.unload();
    runtimes.splice(runtimes.length - 1);
    expect(modal.isClosed).toBe(true);
    expect(Modal.open).toHaveLength(0);
  });
});

describe('R1.1: the command palette lists the plugin commands', () => {
  it('Open Claude Code, Open Antigravity, Open shell and Restore notes from before an AI session…', async () => {
    const app = createMockApp(mkdtempSync(join(tmpdir(), 'vault-')));
    const plugin = new AiTerminalPlugin(app as unknown as App, createManifest());
    await plugin.onload();
    try {
      const names = (plugin as unknown as { commands: Array<{ name: string }> }).commands.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(['Open Claude Code', 'Open Antigravity', 'Open shell', 'Restore notes from before an AI session…']));
      await plugin.context!.ready;
    } finally {
      plugin.onunload();
    }
  });
});
