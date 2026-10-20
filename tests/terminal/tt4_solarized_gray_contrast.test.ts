// Acceptance tests for R4 (gray text slots stay readable) of specs/solarized-terminal-colors/spec.md.
// Black-box through the spec-named public function `buildFixedTheme(mode)`; WCAG contrast is computed here.
import { describe, expect, it } from 'vitest';
import { buildFixedTheme } from '../../src/terminal/theme';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const theme = (mode: string): Record<string, unknown> => (buildFixedTheme as (mode: any) => Record<string, unknown>)(mode);

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: unknown): number {
  expect(typeof hex).toBe('string');
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex as string);
  expect(m, `expected #rrggbb color, got ${String(hex)}`).not.toBeNull();
  const [r, g, b] = [m![1], m![2], m![3]].map((h) => channel(parseInt(h, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: unknown, b: unknown): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('TT4 R4: Solarized gray text slots reach 3:1 against the background', () => {
  for (const mode of ['solarized-dark', 'solarized-light']) {
    for (const slot of ['white', 'brightBlack', 'brightWhite']) {
      it(`R4.1 ${mode} ${slot} has contrast >= 3.0 with background`, () => {
        const t = theme(mode);
        expect(contrast(t[slot], t.background)).toBeGreaterThanOrEqual(3.0);
      });
    }
  }
});
