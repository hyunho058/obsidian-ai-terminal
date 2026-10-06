import { FitAddon } from '@xterm/addon-fit';
import { vi } from 'vitest';
import { createSessionModule } from '../../src/session/index';
import type { SessionRegistry } from '../../src/session/SessionRegistry';
import { createTerminalModule, type TerminalViewsService } from '../../src/terminal/index';
import { TerminalView } from '../../src/terminal/TerminalView';
import type { WorkspaceLeaf } from '../mocks/obsidian';
import { makeHarness, type Harness } from '../session/helpers';

export const FAST = { graceMs: 120, duplicateWindowMs: 60, nudgeDelayMs: 5 };

export interface ViewHarness extends Harness {
  terminals: TerminalViewsService;
  sessions: SessionRegistry;
}

/** env-less runtime: fake pty + the real session and terminal modules. */
export async function makeViewHarness(opts: { gated?: boolean } = {}): Promise<ViewHarness> {
  const h = await makeHarness({
    noRegistry: true,
    gated: opts.gated,
    extraModules: [createSessionModule(FAST), createTerminalModule()],
  });
  const sessions = h.ctx.services.require('sessions') as SessionRegistry;
  return { ...h, registry: sessions, sessions, terminals: h.ctx.services.require('terminals') };
}

/** happy-dom has no layout: make the fit addon report a size. */
export function stubFit(cols = 100, rows = 30) {
  return vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols, rows });
}

export function viewOf(leaf: WorkspaceLeaf): TerminalView {
  if (!(leaf.view instanceof TerminalView)) throw new Error('not a terminal view');
  return leaf.view;
}

export function bufferText(view: TerminalView): string {
  const buf = view.terminal!.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)!.translateToString(true));
  return lines.join('\n');
}

export function flushTerm(view: TerminalView): Promise<void> {
  return new Promise((resolve) => view.terminal!.write('', resolve));
}
