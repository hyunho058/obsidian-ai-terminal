import { afterEach, describe, expect, it } from 'vitest';
import { cleanPrompt, commitMessage, formatTimestamp, NOTES, parseCommit } from '../../src/snapshot/messages';
import { clearSecrets, registerSecret } from '../../src/util/log';

const at = new Date(2026, 9, 7, 14, 3, 59);

describe('commit messages (D31)', () => {
  afterEach(() => clearSecrets());

  it('subjects per AI and kind', () => {
    const subject = (m: Parameters<typeof commitMessage>[0]) => commitMessage(m, at).split('\n')[0];
    expect(subject({ kind: 'prompt', ai: 'claude', prompt: 'make this shorter' })).toBe('Before Claude Code: "make this shorter" — 2026-10-07 14:03');
    expect(subject({ kind: 'prompt', ai: 'claude' })).toBe('Before Claude Code message — 2026-10-07 14:03');
    expect(subject({ kind: 'prompt', ai: 'agy', prompt: 'ignored' })).toBe('Before input in Antigravity — 2026-10-07 14:03');
    expect(subject({ kind: 'spawn', ai: 'claude' })).toBe('Before Claude Code session — 2026-10-07 14:03');
    expect(subject({ kind: 'spawn', ai: 'agy' })).toBe('Before Antigravity session — 2026-10-07 14:03');
    expect(subject({ kind: 'restore' })).toBe('Before restore — 2026-10-07 14:03');
    expect(subject({ kind: 'first' })).toBe('Snapshots turned on — 2026-10-07 14:03');
    expect(subject({ kind: 'restore', label: 'Before restore of 3 notes' })).toBe('Before restore of 3 notes — 2026-10-07 14:03');
  });

  it('first 60 characters of a one-line prompt in the subject (code points, not UTF-16 units), 200 in the trailer', () => {
    const long = '가'.repeat(59) + '😀' + 'tail'.repeat(100);
    const msg = commitMessage({ kind: 'prompt', ai: 'claude', prompt: `  line one\n\tline\u0000two  ${long}` }, at);
    const [subject, blank, ...trailers] = msg.trimEnd().split('\n');
    expect(subject).toBe(`Before Claude Code: "${Array.from(`line one line two ${long}`).slice(0, 60).join('')}" — 2026-10-07 14:03`);
    expect(blank).toBe('');
    const prompt = JSON.parse(trailers.find((t) => t.startsWith('Prompt: '))!.slice(8));
    expect(Array.from(prompt)).toHaveLength(200);
    expect(prompt.startsWith('line one line two 가')).toBe(true);
  });

  it('tokens never reach a commit message', () => {
    registerSecret('super-secret-token-123');
    const msg = commitMessage({ kind: 'prompt', ai: 'claude', prompt: 'use super-secret-token-123 please', panelId: 'p1' }, at);
    expect(msg).not.toContain('super-secret-token-123');
    expect(msg).toContain('[REDACTED]');
  });

  it('trailers round-trip through parseCommit', () => {
    const msg = commitMessage({ kind: 'prompt', ai: 'claude', panelId: 'panel-9', prompt: 'say "hi": now' }, at);
    expect(msg.split('\n').slice(2).filter(Boolean)).toEqual(['AI: claude', 'Kind: prompt', 'Panel: panel-9', 'Prompt: "say \\"hi\\": now"']);
    expect(parseCommit('abc1234', 1_790_000_000, msg)).toEqual({
      commit: 'abc1234',
      time: 1_790_000_000_000,
      subject: 'Before Claude Code: "say "hi": now" — 2026-10-07 14:03',
      kind: 'prompt',
      ai: 'claude',
      panelId: 'panel-9',
      promptExcerpt: 'say "hi": now',
    });
    expect(parseCommit('abc1234', 1, 'hand-made commit\n\nAI: gpt\nKind: weird\nPrompt: {not json')).toEqual({
      commit: 'abc1234',
      time: 1000,
      subject: 'hand-made commit',
      kind: 'unknown',
    });
  });

  it('helpers', () => {
    expect(formatTimestamp(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02 03:04');
    expect(cleanPrompt('a\r\nb c', 10)).toBe('a b c');
    expect(cleanPrompt(undefined, 10)).toBe('');
    expect(NOTES.failed('disk full')).toBe('[Snapshot failed: disk full — this message is not protected]');
    expect(NOTES.pendingAgy).toBe("[Snapshot still running — it may include this message's changes]");
  });
});
