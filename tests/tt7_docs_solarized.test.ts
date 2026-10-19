// TT7 — acceptance tests for R7 (User guide documents the choices — D8) of specs/solarized-terminal-colors/spec.md.
// Reads docs/user-guide.md like tests/tt4_docs_image_paste.test.ts does; wording is matched loosely (the spec fixes no exact text).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** The "Terminal colors" paragraph: from the line naming it up to the next blank line or heading. */
function terminalColorsParagraph(): string {
  const lines = read('docs/user-guide.md').split('\n');
  const start = lines.findIndex((line) => /terminal colou?rs/i.test(line) && !/^#/.test(line.trim()));
  expect(start, 'docs/user-guide.md has a "Terminal colors" paragraph').toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > start && (line.trim() === '' || /^#/.test(line.trim()))) break;
    out.push(line);
  }
  return out.join('\n');
}

describe('R7 — user guide documents the Solarized choices', () => {
  it('R7.1 the "Terminal colors" paragraph names Solarized Dark and Solarized Light along with the existing three choices', () => {
    const para = terminalColorsParagraph();
    expect(para).toMatch(/Solarized Dark/i);
    expect(para).toMatch(/Solarized Light/i);
    expect(para).toMatch(/Follow Obsidian theme/i);
    // The existing "Dark" and "Light" choices, distinct from the Solarized ones.
    expect(para.replace(/Solarized Dark/gi, '')).toMatch(/\bDark\b/);
    expect(para.replace(/Solarized Light/gi, '')).toMatch(/\bLight\b/);
  });

  it('R7.2 the "Terminal colors" paragraph says Claude Code / Antigravity draw some colors themselves and mentions /theme', () => {
    const para = terminalColorsParagraph();
    expect(para).toMatch(/Claude Code/i);
    expect(para).toMatch(/Antigravity|\bagy\b/i);
    expect(para).toMatch(/\/theme\b/);
    // "draw some colors themselves" — loosely: their own colors / themselves / not changed.
    expect(para).toMatch(/\bown\b|themselves|not (?:change|affect|recolou?r)|unchanged|keep/i);
  });
});
