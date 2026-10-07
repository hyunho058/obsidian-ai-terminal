import type { IncomingMessage, ServerResponse } from 'http';
import { isAiProfile, type RouteHandler, type TerminalPanelHandle } from '../core';
import type { Logger } from '../util/log';
import { NOTES, TRAILER_PROMPT_CHARS } from './messages';
import type { SnapshotAi, SnapshotResult, SnapshotsService } from './types';

export const SNAPSHOT_ROUTE = '/snapshot';
/** The Claude hook's wait (D31): the response is sent when the snapshot is done or after 10 s. */
export const HOOK_WAIT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface SnapshotRouteOptions {
  service: Pick<SnapshotsService, 'requestSnapshot'>;
  /** Live panel lookup (`sessions.get`), used to print notes into the panel. */
  getPanel: (panelId: string) => TerminalPanelHandle | undefined;
  waitMs?: number;
  log?: Logger;
}

/** Prints a note on its own line in a terminal panel (local display only). */
export function printNote(panel: TerminalPanelHandle | undefined, note: string): void {
  if (!panel) return;
  try {
    panel.print(`\r\n${note}\r\n`);
  } catch {
    // the panel went away
  }
}

/** Notes for a message whose snapshot did not complete (R12.9, R12.10). */
export function noteFor(result: SnapshotResult, ai: SnapshotAi): string | null {
  if (result.status === 'failed') return NOTES.failed(result.reason ?? 'unknown error');
  if (result.status === 'pending') return ai === 'agy' ? NOTES.pendingAgy : NOTES.pendingClaude;
  return null;
}

/**
 * `POST /snapshot` (R12.4), called by `snapshot_hook.py` before each Claude message. The bridge server has already
 * checked the bearer token. Body `{panelId, prompt?, ai}` → `{status, reason?, commit?}` once the snapshot finished
 * or after 10 s (`pending` — git keeps running).
 */
export function createSnapshotRoute(o: SnapshotRouteOptions): RouteHandler {
  return async (req, res) => {
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === 'too-large') {
      sendJson(res, 413, { status: 'failed', reason: 'request body too large' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = body.length ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { status: 'failed', reason: 'invalid JSON' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 400, { status: 'failed', reason: 'expected a JSON object' });
      return;
    }
    const input = parsed as Record<string, unknown>;
    const panelId = typeof input.panelId === 'string' && input.panelId ? input.panelId.slice(0, 200) : undefined;
    const ai: SnapshotAi = input.ai === 'agy' ? 'agy' : 'claude';
    const prompt = typeof input.prompt === 'string' ? Array.from(input.prompt).slice(0, TRAILER_PROMPT_CHARS).join('') : undefined;

    const panel = panelId ? o.getPanel(panelId) : undefined;
    if (panel && !isAiProfile(panel.profile)) {
      sendJson(res, 200, { status: 'disabled', reason: 'shell panels are not snapshotted' });
      return;
    }
    const result = await o.service.requestSnapshot({ kind: 'prompt', ai, panelId, prompt }, { waitMs: o.waitMs ?? HOOK_WAIT_MS });
    const note = noteFor(result, ai);
    if (note && panelId) printNote(o.getPanel(panelId), note);
    if (result.status === 'failed' || result.status === 'pending') o.log?.info(`snapshot before a ${ai} message: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    sendJson(res, 200, result);
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req: IncomingMessage, limit: number): Promise<string | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? 'too-large' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
