// Acceptance tests for R3 (Solarized Light palette) — D2, D3, D4, D5.
// Expected values come from specs/solarized-terminal-colors/spec.md.
import { describe, expect, it } from 'vitest';
import { buildFixedTheme } from '../../src/terminal/theme';

describe('R3: Solarized Light palette', () => {
  it('R3.1: background, foreground, cursor and selection', () => {
    const t = buildFixedTheme('solarized-light');
    expect(t.background).toBe('#fdf6e3');
    expect(t.foreground).toBe('#657b83');
    expect(t.cursor).toBe('#268bd2');
    expect(t.cursorAccent).toBe('#fdf6e3');
    expect(t.selectionBackground).toBe('#d3cfc1');
    expect(t.selectionInactiveBackground).toBe('#d3cfc1');
    expect(t.selectionForeground).toBeUndefined();
  });

  it('R3.2: hue slots (bright = normal hue)', () => {
    const t = buildFixedTheme('solarized-light');
    expect(t).toMatchObject({
      red: '#dc322f',
      brightRed: '#dc322f',
      green: '#859900',
      brightGreen: '#859900',
      yellow: '#b58900',
      brightYellow: '#b58900',
      blue: '#268bd2',
      brightBlue: '#268bd2',
      magenta: '#d33682',
      brightMagenta: '#d33682',
      cyan: '#2aa198',
      brightCyan: '#2aa198',
    });
  });

  it('R3.3: gray slots', () => {
    const t = buildFixedTheme('solarized-light');
    expect(t).toMatchObject({
      black: '#073642',
      white: '#657b83',
      brightBlack: '#586e75',
      brightWhite: '#586e75',
    });
  });
});
