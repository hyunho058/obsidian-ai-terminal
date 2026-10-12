// R15.3 — the README's Safety section covers the caveats; the user guide has the full details; the First run checklist
// (docs/development.md) gives every in-app check an "Expect".
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => ({ file, text: readFileSync(new URL(`../${file}`, import.meta.url), 'utf8') });
const README = read('README.md');
const GUIDE = read('docs/user-guide.md');
const DEVELOPMENT = read('docs/development.md');

/** The text of a `## <title>` section of a doc, up to the next `## ` heading. */
function section(doc: { file: string; text: string }, title: string): string {
  const start = doc.text.indexOf(`\n## ${title}\n`);
  expect(start, `${doc.file} has a "## ${title}" section`).toBeGreaterThanOrEqual(0);
  const body = doc.text.slice(start + title.length + 5);
  const end = body.search(/^## /m);
  return end === -1 ? body : body.slice(0, end);
}

describe('README and docs', () => {
  it('README Safety covers typing in a note the AI edits, File Recovery, `agy mcp remove obsidian` and history after a vault move (R15.3)', () => {
    const safety = section(README, 'Safety');
    expect(safety).toMatch(/do not type in a note while the AI is editing it/i);
    expect(safety).toMatch(/\*\*File Recovery\*\*/);
    expect(safety).toContain('`agy mcp remove obsidian`');
    expect(safety).toMatch(/history restarts after a vault move/i);
    expect(safety).toMatch(/moving or renaming the vault folder starts a new, empty history/i);
  });

  it('user guide Safety explains that the bridge keeps its port until the plugin stops (deviation 20)', () => {
    const safety = section(GUIDE, 'Safety');
    expect(safety).toMatch(/keeps its port until the plugin stops/i);
    expect(safety).toMatch(/answers every request\s+with "turned off"/);
    expect(safety).toMatch(/no other program can take that port/i);
  });

  it('user guide Safety explains that the Claude Code IDE connection keeps its port too (deviation 21)', () => {
    const safety = section(GUIDE, 'Safety');
    expect(safety).toMatch(/\*\*Claude Code IDE connection\*\* keeps its port in the same way/);
    expect(safety).toMatch(/removes its lock file, disconnects Claude and refuses new connections, but it keeps the same port/);
    expect(safety).toMatch(/the lock file comes back with the same port/);
    expect(safety).toMatch(/removes it when you turn the connection off or the\s+plugin stops/);
  });

  it('Troubleshooting says how to reload the plugin (Notices say "Reload the plugin")', () => {
    const troubleshooting = section(GUIDE, 'Troubleshooting');
    expect(troubleshooting).toMatch(/\*\*How to reload the plugin\*\*/);
    expect(troubleshooting).toMatch(/Settings › Community plugins, turn\s+\*\*AI Terminal\*\* off, then turn it on again/);
  });

  it('Antigravity explains the tool permission rule; Troubleshooting says what to check (deviation 22)', () => {
    const agy = section(GUIDE, 'The Obsidian bridge').split('### Antigravity')[1] ?? '';
    expect(agy).toMatch(/Antigravity asks permission before it uses MCP tools\. The plugin allows the Obsidian tools for you\s+\(`mcp\(obsidian\/\*\)` in agy's settings\) and removes this when you turn the Antigravity bridge off\./);
    expect(agy).toMatch(/Restart running Antigravity panels after the first setup\./);
    expect(agy).toContain('`~/.gemini/antigravity-cli/settings.json`');
    expect(section(GUIDE, 'Troubleshooting')).toMatch(
      /\*\*Antigravity does not use the Obsidian tools\*\* → restart the Antigravity panel; check that agy's settings contain\s+`mcp\(obsidian\/\*\)`/,
    );
    const safety = section(GUIDE, 'Safety');
    expect(safety).toMatch(/the rule `mcp\(obsidian\/\*\)` that allows its tools/);
    expect(safety).toMatch(/remove the rule `mcp\(obsidian\/\*\)` from\s+`permissions\.allow`/);
    expect(section(DEVELOPMENT, 'First run checklist')).toMatch(/agy uses the obsidian tool `get_active_note` without asking for permission/);
  });

  it('every First run checklist step says what to expect', () => {
    const checklist = section(DEVELOPMENT, 'First run checklist');
    const steps = checklist.split(/^\d+\. /m).slice(1);
    expect(steps.length).toBeGreaterThanOrEqual(20);
    for (const step of steps) expect(step, step.split('\n')[0]).toContain('Expect');
    // In-app-only checks named by the spec.
    for (const text of [
      'the cursor is in the panel — you can type without clicking', // R1.3
      'Cmd-click the link', // R2.9
      'press Shift+Enter', // R4.6
      'none for terminal tabs you have not clicked yet', // R5.9
      '**Diff tool** → **terminal**', // R10.6
      '`get_active_note` and answers `X.md`', // R11.2
    ]) {
      expect(checklist).toContain(text);
    }
  });
});
