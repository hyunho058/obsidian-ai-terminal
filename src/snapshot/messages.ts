import { redact } from '../util/log';
import type { SnapshotAi, SnapshotInfo, SnapshotKind, SnapshotMeta } from './types';

/** Characters of the prompt shown in the commit subject (D31). */
export const SUBJECT_PROMPT_CHARS = 60;
/** Characters of the prompt kept in the `Prompt:` trailer (and sent by the hook). */
export const TRAILER_PROMPT_CHARS = 200;

const AI_LABELS: Record<SnapshotAi, string> = { claude: 'Claude Code', agy: 'Antigravity' };
const KINDS: readonly SnapshotKind[] = ['prompt', 'spawn', 'restore', 'first'];

/** Panel notes (D31, R12.7, R12.9, R12.10). */
export const NOTES = {
  failed: (reason: string) => `[Snapshot failed: ${reason} — this message is not protected]`,
  pendingClaude: '[Snapshot still running — this message may not be protected]',
  pendingAgy: "[Snapshot still running — it may include this message's changes]",
  spawnFailed: (reason: string) => `[Snapshot failed: ${reason} — starting without a restore point]`,
  spawnPending: '[Snapshot still running — starting without waiting for it]',
  enabled: '[Snapshots on — saving the first restore point in the background]',
} as const;

/** `YYYY-MM-DD HH:mm` in local time. */
export function formatTimestamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

// C0/C1 controls and the Unicode line / paragraph separators.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');

/** One line: control characters and line breaks become spaces, runs of whitespace collapse; secrets are redacted. */
export function cleanPrompt(prompt: string | undefined, maxChars: number): string {
  if (!prompt) return '';
  const oneLine = redact(prompt).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('').trimEnd() : oneLine;
}

/** Safe single-line trailer value (panel ids, labels). */
function cleanToken(value: string | undefined, max = 100): string | undefined {
  if (!value) return undefined;
  const v = cleanPrompt(value, max);
  return v || undefined;
}

/**
 * Commit message (D31): a readable subject, then trailers T10 parses (`AI`, `Kind`, `Panel`, `Prompt` as JSON).
 * - `Before Claude Code: "<first 60 chars>" — <YYYY-MM-DD HH:mm>`
 * - `Before input in Antigravity — …` · `Before Claude Code session — …` · `Before Antigravity session — …`
 * - `Before restore — …` · `Snapshots turned on — …`
 */
export function commitMessage(meta: SnapshotMeta, now: Date): string {
  const when = formatTimestamp(now);
  const label = cleanToken(meta.label, 80);
  const ai = meta.ai ? AI_LABELS[meta.ai] : undefined;
  let subject: string;
  if (label) subject = `${label} — ${when}`;
  else if (meta.kind === 'prompt') {
    if (meta.ai === 'agy') subject = `Before input in Antigravity — ${when}`;
    else {
      const excerpt = cleanPrompt(meta.prompt, SUBJECT_PROMPT_CHARS);
      subject = excerpt ? `Before ${ai ?? 'Claude Code'}: "${excerpt}" — ${when}` : `Before ${ai ?? 'Claude Code'} message — ${when}`;
    }
  } else if (meta.kind === 'spawn') subject = `Before ${ai ?? 'AI'} session — ${when}`;
  else if (meta.kind === 'restore') subject = `Before restore — ${when}`;
  else subject = `Snapshots turned on — ${when}`;

  const trailers: string[] = [];
  if (meta.ai) trailers.push(`AI: ${meta.ai}`);
  trailers.push(`Kind: ${meta.kind}`);
  const panel = cleanToken(meta.panelId);
  if (panel) trailers.push(`Panel: ${panel}`);
  const prompt = cleanPrompt(meta.prompt, TRAILER_PROMPT_CHARS);
  if (prompt) trailers.push(`Prompt: ${JSON.stringify(prompt)}`);
  return `${subject}\n\n${trailers.join('\n')}\n`;
}

/** Parses one `git log` record (`hash`, commit time in seconds, raw message). */
export function parseCommit(commit: string, unixSeconds: number, message: string): SnapshotInfo {
  const lines = message.replace(/\r/g, '').split('\n');
  const subject = (lines[0] ?? '').trim();
  const info: SnapshotInfo = { commit, time: unixSeconds * 1000, subject, kind: 'unknown' };
  for (const line of lines.slice(1)) {
    const m = /^(AI|Kind|Panel|Prompt): (.*)$/.exec(line.trim());
    if (!m) continue;
    const value = m[2] ?? '';
    if (m[1] === 'AI') {
      if (value === 'claude' || value === 'agy') info.ai = value;
    } else if (m[1] === 'Kind') {
      if ((KINDS as readonly string[]).includes(value)) info.kind = value as SnapshotKind;
    } else if (m[1] === 'Panel') {
      if (value) info.panelId = value;
    } else {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed === 'string' && parsed) info.promptExcerpt = parsed;
      } catch {
        // not ours
      }
    }
  }
  return info;
}
