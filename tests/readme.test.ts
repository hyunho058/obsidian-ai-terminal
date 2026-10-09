// R15.3 — the README's Safety section covers the caveats; the First run checklist gives every in-app check an "Expect".
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** The text of a `## <title>` section, up to the next `## ` heading. */
function section(title: string): string {
  const start = README.indexOf(`\n## ${title}\n`);
  expect(start, `README has a "## ${title}" section`).toBeGreaterThanOrEqual(0);
  const body = README.slice(start + title.length + 5);
  const end = body.search(/^## /m);
  return end === -1 ? body : body.slice(0, end);
}

describe('README', () => {
  it('Safety covers typing in a note the AI edits, File Recovery, `agy mcp remove obsidian` and history after a vault move (R15.3)', () => {
    const safety = section('Safety');
    expect(safety).toMatch(/do not type in a note while the AI is editing it/i);
    expect(safety).toMatch(/\*\*File Recovery\*\*/);
    expect(safety).toContain('`agy mcp remove obsidian`');
    expect(safety).toMatch(/history restarts after a vault move/i);
    expect(safety).toMatch(/moving or renaming the vault folder starts a new, empty history/i);
  });

  it('Safety explains that the bridge keeps its port until the plugin stops (deviation 20)', () => {
    const safety = section('Safety');
    expect(safety).toMatch(/keeps its port until the plugin stops/i);
    expect(safety).toMatch(/answers every request\s+with "turned off"/);
    expect(safety).toMatch(/no other program can take that port/i);
  });

  it('Safety explains that the Claude Code IDE connection keeps its port too (deviation 21)', () => {
    const safety = section('Safety');
    expect(safety).toMatch(/\*\*Claude Code IDE connection\*\* keeps its port in the same way/);
    expect(safety).toMatch(/removes its lock file, disconnects Claude and refuses new connections, but it keeps the same port/);
    expect(safety).toMatch(/the lock file comes back with the same port/);
    expect(safety).toMatch(/removes it when you turn the connection off or the\s+plugin stops/);
  });

  it('Troubleshooting says how to reload the plugin (Notices say "Reload the plugin")', () => {
    const troubleshooting = section('Troubleshooting');
    expect(troubleshooting).toMatch(/\*\*How to reload the plugin\*\*/);
    expect(troubleshooting).toMatch(/Settings › Community plugins, turn\s+\*\*AI Terminal\*\* off, then turn it on again/);
  });

  it('every First run checklist step says what to expect', () => {
    const checklist = section('First run checklist');
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
