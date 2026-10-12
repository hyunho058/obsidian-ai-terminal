import { randomUUID } from 'crypto';
import type { SpawnContext, SpawnContribution, SpawnContributor } from '../core/spawn';
import type { Logger } from '../util/log';
import { claudeConfigDir, lookupClaudeTranscript, type TranscriptLookup } from './resumeTranscript';

/** R5.7 */
export const ANOTHER_FOLDER_NOTICE = '[Previous conversation belongs to another folder — starting a new one]';
/** R5.10 */
export const AGY_NOT_FOUND_NOTICE = '[Previous conversation not found — starting a new one]';
/** R5.10: `agy --continue` exiting non-zero within this window means "nothing to continue". */
export const AGY_CONTINUE_FALLBACK_MS = 5_000;
/** A transcript lookup that takes longer than this is treated as unreadable (keeps the id, never blocks a start). */
export const LOOKUP_TIMEOUT_MS = 3_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code accepts only UUIDs as session ids; anything else in a view state is ignored. */
export function isSessionUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Arguments with which the user already picks the conversation themselves (Settings › Profiles). */
const CLAUDE_CONVERSATION_FLAGS = ['--resume', '-r', '--continue', '-c', '--session-id'];
const AGY_CONVERSATION_FLAGS = ['--continue', '-c', '--conversation'];

export function choosesConversation(args: readonly string[], flags: readonly string[]): boolean {
  return args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)));
}

export interface ResumeDeps {
  log: Logger;
  /** Claude Code's config folder for this spawn (`$CLAUDE_CONFIG_DIR` or `~/.claude`). */
  configDir?: () => string;
  newId?: () => string;
  lookup?: (sessionId: string, vaultPath: string, configDir: string) => Promise<TranscriptLookup>;
  lookupTimeoutMs?: number;
}

/**
 * The `resume` spawn contributor (D21, D22). Pure function of the spawn context and the transcript files, so
 * every panel resolves its own conversation (R5.8). The stored id changes only when a fresh conversation has to
 * be started (R5.7, or nothing resumable under the old id); an early exit never changes it (R5.12) — the
 * launcher keeps the id unless a contributor returns a new one.
 */
export function createResumeContributor(deps: ResumeDeps): SpawnContributor {
  const newId = deps.newId ?? randomUUID;
  const configDir = deps.configDir ?? (() => claudeConfigDir(process.env));
  const lookup =
    deps.lookup ?? ((sessionId: string, vaultPath: string, dir: string) => lookupClaudeTranscript(sessionId, vaultPath, { configDir: dir }));
  const timeoutMs = deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  const { log } = deps;

  const fresh = (ctx: SpawnContext): SpawnContribution => {
    const id = newId();
    return { replaceArgs: [...ctx.baseArgs, '--session-id', id], sessionId: id };
  };

  const claude = async (ctx: SpawnContext): Promise<SpawnContribution | void> => {
    if (choosesConversation(ctx.baseArgs, CLAUDE_CONVERSATION_FLAGS)) {
      log.debug(`panel ${ctx.panelId}: the profile arguments pick the conversation — resume left alone`);
      return;
    }
    const id = ctx.sessionId;
    if (ctx.phase === 'new' || !isSessionUuid(id)) {
      if (ctx.phase !== 'new' && id !== undefined) log.debug(`panel ${ctx.panelId}: ignoring stored session id that is not a UUID`);
      return fresh(ctx);
    }
    const sameId: SpawnContribution = { replaceArgs: [...ctx.baseArgs, '--session-id', id] };
    let found: TranscriptLookup;
    try {
      found = await withTimeout(lookup(id, ctx.vaultPath, configDir()), timeoutMs);
    } catch (err) {
      log.debug(`panel ${ctx.panelId}: transcript lookup failed — keeping session ${id}`, err);
      return sameId;
    }
    if (found.errors.length) log.debug(`panel ${ctx.panelId}: transcript read errors`, found.errors);
    switch (found.status) {
      case 'match':
        log.debug(`panel ${ctx.panelId}: resuming ${id} (${found.files.join(', ')})`);
        return { replaceArgs: [...ctx.baseArgs, '--resume', id] };
      case 'missing':
        return sameId;
      case 'elsewhere': {
        const next = fresh(ctx);
        log.debug(`panel ${ctx.panelId}: conversation ${id} was recorded in ${found.firstCwd ?? '?'} — starting ${next.sessionId}`);
        return { ...next, notice: ANOTHER_FOLDER_NOTICE };
      }
      case 'empty': {
        // Claude refuses `--session-id <id>` once `<project>/<id>.jsonl` exists ("Session ID … is already in use"),
        // and a transcript without any recorded `cwd` holds no messages, so a new id loses nothing.
        const next = fresh(ctx);
        log.debug(`panel ${ctx.panelId}: transcript of ${id} has no messages — starting ${next.sessionId}`);
        return next;
      }
      case 'unreadable':
        log.debug(`panel ${ctx.panelId}: transcript of ${id} could not be read — keeping the id`);
        return sameId;
    }
  };

  const agy = (ctx: SpawnContext): SpawnContribution | void => {
    if (ctx.phase === 'new') return;
    if (choosesConversation(ctx.baseArgs, AGY_CONVERSATION_FLAGS)) return;
    return {
      replaceArgs: [...ctx.baseArgs, '--continue'],
      fallback: { withinMs: AGY_CONTINUE_FALLBACK_MS, replaceArgs: [...ctx.baseArgs], notice: AGY_NOT_FOUND_NOTICE },
    };
  };

  return async (ctx) => {
    try {
      if (ctx.profile === 'claude') return await claude(ctx);
      if (ctx.profile === 'agy') return agy(ctx);
      return;
    } catch (err) {
      // Never block a start: keep the stored id if there is one, else start the plain command.
      log.debug(`panel ${ctx.panelId}: resume contributor failed`, err);
      if (ctx.profile === 'claude' && ctx.phase !== 'new' && isSessionUuid(ctx.sessionId)) {
        return { replaceArgs: [...ctx.baseArgs, '--session-id', ctx.sessionId] };
      }
      return;
    }
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
