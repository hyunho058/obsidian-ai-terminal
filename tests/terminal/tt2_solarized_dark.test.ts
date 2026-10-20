// Acceptance tests for R2 (Solarized Dark palette) of specs/solarized-terminal-colors/spec.md.
// Black-box through the spec-named public function `buildFixedTheme('solarized-dark')`.
import { describe, expect, it } from 'vitest';
import { buildFixedTheme } from '../../src/terminal/theme';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const solarizedDark = (): Record<string, unknown> => (buildFixedTheme as (mode: any) => Record<string, unknown>)('solarized-dark');

describe('TT2 R2: Solarized Dark palette', () => {
  it('R2.1 background, foreground, cursor and selection', () => {
    const t = solarizedDark();
    expect(t.background).toBe('#002b36');
    expect(t.foreground).toBe('#839496');
    expect(t.cursor).toBe('#268bd2');
    expect(t.cursorAccent).toBe('#002b36');
    expect(t.selectionBackground).toBe('rgba(147, 161, 161, 0.25)');
    expect(t.selectionInactiveBackground).toBe('rgba(147, 161, 161, 0.25)');
    expect(t.selectionForeground).toBeUndefined();
  });

  it('R2.2 hue slots: bright hues repeat the normal hue', () => {
    const t = solarizedDark();
    const hues: Record<string, string> = {
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
    };
    for (const [name, hex] of Object.entries(hues)) {
      const bright = `bright${name[0].toUpperCase()}${name.slice(1)}`;
      expect(t[name], name).toBe(hex);
      expect(t[bright], bright).toBe(hex);
    }
  });

  it('R2.3 gray slots', () => {
    const t = solarizedDark();
    expect(t.black).toBe('#073642');
    expect(t.white).toBe('#eee8d5');
    expect(t.brightBlack).toBe('#657b83');
    expect(t.brightWhite).toBe('#fdf6e3');
  });
});
