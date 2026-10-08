// Loop iteration 2 — short, plain Notices: one sentence + the fix, no internal ids, no foreign config details.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FOREIGN_ENTRY_NOTICE } from '../../src/bridge/agyModule';
import { createBridgeModule } from '../../src/bridge/index';
import { createIdeModule, IDE_START_FAILED_NOTICE } from '../../src/bridge/ideModule';
import { createEnvModule, fallbackNoticeText } from '../../src/env/index';
import { createBridgeEnv, startRuntime } from '../bridge/helpers';
import { Notice } from '../mocks/obsidian';

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const runtimes: Runtime[] = [];

beforeEach(() => Notice.clear());
afterEach(() => {
  for (const rt of runtimes.splice(0)) if (!rt.ctx.unloading) rt.runtime.unload();
});

/** Sentences after the "AI Terminal:" prefix (a period followed by a space or the end). */
function sentences(message: string): number {
  return (message.replace(/^AI Terminal: /, '').match(/[.!?](\s|$)/g) ?? []).length;
}

describe('shortened Notices (one sentence + the fix)', () => {
  it('foreign agy entry: says it exists and how to remove it — nothing else', () => {
    expect(FOREIGN_ENTRY_NOTICE).toBe(
      'AI Terminal: Antigravity already has another MCP server named "obsidian", so agy cannot use the bridge. Run `agy mcp remove obsidian` and reload the plugin.',
    );
    expect(sentences(FOREIGN_ENTRY_NOTICE)).toBe(2);
  });

  it('IDE connection failure: what is lost + the fix', () => {
    expect(IDE_START_FAILED_NOTICE).toMatch(/^AI Terminal: the Claude Code IDE connection could not start, so .+\. Reload the plugin to try again\.$/);
    expect(sentences(IDE_START_FAILED_NOTICE)).toBe(2);
    expect(IDE_START_FAILED_NOTICE).not.toMatch(/developer console|obsidian tools/);
  });

  it('shell-environment fallback: keeps the R3.3 facts (fallback PATH) and the fix, drops the raw error', () => {
    const text = fallbackNoticeText();
    expect(text).toContain('fallback PATH with ~/.local/bin and /opt/homebrew/bin');
    expect(text).toMatch(/check Settings › Profiles\.$/);
    expect(sentences(text)).toBe(2);
  });

  it('the IDE module shows IDE_START_FAILED_NOTICE once when the connection cannot start', async () => {
    const blocked = join(mkdtempSync(join(tmpdir(), 'ide-')), 'not-a-dir');
    writeFileSync(blocked, 'a file where the lock folder should be');
    const rt = await startRuntime(createBridgeEnv(), [createBridgeModule(), createIdeModule({ lockDir: blocked, seedDelaysMs: [], windowTarget: null })]);
    runtimes.push(rt);
    expect(Notice.shown.map((n) => n.message)).toEqual([IDE_START_FAILED_NOTICE]);
    expect(rt.ctx.services.require('ide').isRunning()).toBe(false);
  });

  it('the env module shows the short fallback Notice when the login shell fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badshell-'));
    const shell = join(dir, 'sh');
    writeFileSync(shell, '#!/bin/sh\necho "secret-ish failure detail" >&2\nexit 1\n');
    chmodSync(shell, 0o755);
    const rt = await startRuntime(createBridgeEnv(), [createEnvModule({ shell, timeoutMs: 2000 })]);
    runtimes.push(rt);
    expect(rt.ctx.services.require('shellEnv').status).toBe('fallback');
    expect(Notice.shown.map((n) => n.message)).toEqual([fallbackNoticeText()]);
    expect(rt.out.lines.some((l) => l.includes('using the fallback PATH'))).toBe(true); // the reason stays in the log
  });
});
