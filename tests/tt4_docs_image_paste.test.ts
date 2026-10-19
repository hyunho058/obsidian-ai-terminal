// TT4 — acceptance tests for R4 (Docs describe image paste — D6) of specs/paste-image/spec.md.
// Reads the three doc files like tests/readme.test.ts does; wording is matched loosely (the spec fixes no exact text).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** Markdown table rows (lines starting with `|`, indentation allowed), trimmed. */
const tableRows = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));

/** The text of a `## <title>` section, up to the next `## ` heading. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  expect(start, `has a "## ${title}" section`).toBeGreaterThanOrEqual(0);
  const body = text.slice(start + title.length + 5);
  const end = body.search(/^## /m);
  return end === -1 ? body : body.slice(0, end);
}

const mentionsImage = /image|screenshot/i;
const mentionsClaude = /claude/i;
const mentionsAgy = /antigravity|\bagy\b/i;

describe('R4 — docs describe image paste', () => {
  it('R4.1 user guide keyboard table: the Cmd+V row mentions pasting an image into Claude Code / Antigravity, and that text wins', () => {
    const rows = tableRows(read('docs/user-guide.md')).filter((row) => /^\|\s*Cmd\+V\b/.test(row));
    expect(rows.length, 'docs/user-guide.md has a keyboard table row for Cmd+V').toBeGreaterThan(0);
    const row = rows.join('\n');
    expect(row).toMatch(mentionsImage);
    expect(row).toMatch(mentionsClaude);
    expect(row).toMatch(mentionsAgy);
    // "text wins when both are on the clipboard"
    expect(row).toMatch(/text/i);
    expect(row).toMatch(/\bboth\b|\bwins?\b|\bfirst\b|\bover\b|\bbefore\b|\binstead\b|\bpriority\b|\bprefer/i);
  });

  it('R4.2 README shortcut table: the Copy / paste row (or a row next to it) says Cmd+V also attaches a clipboard image in Claude Code and Antigravity panels', () => {
    const rows = tableRows(read('README.md'));
    const at = rows.findIndex((row) => /^\|\s*Copy \/ paste\s*\|/i.test(row));
    expect(at, 'README.md has a "Copy / paste" shortcut row').toBeGreaterThanOrEqual(0);
    const candidates = [rows[at - 1], rows[at], rows[at + 1]].filter((row): row is string => row !== undefined);
    const match = candidates.find(
      (row) => /Cmd\+V/.test(row) && mentionsImage.test(row) && mentionsClaude.test(row) && mentionsAgy.test(row),
    );
    expect(match, `a row at or next to "Copy / paste" mentions Cmd+V, an image, Claude Code and Antigravity:\n${candidates.join('\n')}`).toBeDefined();
  });

  it('R4.3 first-run checklist: a step takes a screenshot to the clipboard, presses Cmd+V in a Claude panel, and Expects [Image #1]', () => {
    const checklist = section(read('docs/development.md'), 'First run checklist');
    const steps = checklist.split(/^\s*\d+\.\s/m).slice(1);
    const step = steps.find(
      (s) => /screenshot/i.test(s) && /clipboard/i.test(s) && /Cmd\+V/.test(s) && mentionsClaude.test(s),
    );
    expect(step, 'a checklist step takes a screenshot to the clipboard and presses Cmd+V in a Claude panel').toBeDefined();
    expect(step).toMatch(/Expect:[\s\S]*\[Image #1\]/);
  });
});
