import type { ITheme } from '@xterm/xterm';
import type { TerminalColors } from '../settings';

/** Reads one Obsidian CSS variable (e.g. `--background-primary`); empty string when unset. */
export type CssVarReader = (name: string) => string;

type Palette = Required<
  Pick<
    ITheme,
    | 'background'
    | 'foreground'
    | 'cursor'
    | 'cursorAccent'
    | 'selectionBackground'
    | 'black'
    | 'red'
    | 'green'
    | 'yellow'
    | 'blue'
    | 'magenta'
    | 'cyan'
    | 'white'
    | 'brightBlack'
    | 'brightRed'
    | 'brightGreen'
    | 'brightYellow'
    | 'brightBlue'
    | 'brightMagenta'
    | 'brightCyan'
    | 'brightWhite'
  >
>;

/** Obsidian's default theme values, used when a variable is missing (old / unusual themes). */
const FALLBACK: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--background-primary': '#ffffff',
    '--text-normal': '#222222',
    '--text-accent': '#8a5cf5',
    '--text-selection': 'rgba(138, 92, 245, 0.25)',
    '--color-red': '#e93147',
    '--color-green': '#08b94e',
    '--color-yellow': '#e0ac00',
    '--color-orange': '#ec7500',
    '--color-blue': '#086ddd',
    '--color-purple': '#7852ee',
    '--color-pink': '#d53984',
    '--color-cyan': '#00bfbc',
    '--color-base-40': '#bdbdbd',
    '--color-base-50': '#ababab',
    '--color-base-60': '#707070',
    '--color-base-70': '#5a5a5a',
    '--color-base-100': '#222222',
  },
  dark: {
    '--background-primary': '#1e1e1e',
    '--text-normal': '#dadada',
    '--text-accent': '#a68af9',
    '--text-selection': 'rgba(138, 92, 245, 0.35)',
    '--color-red': '#fb464c',
    '--color-green': '#44cf6e',
    '--color-yellow': '#e0de71',
    '--color-orange': '#e9973f',
    '--color-blue': '#027aff',
    '--color-purple': '#a882ff',
    '--color-pink': '#fa99cd',
    '--color-cyan': '#53dfdd',
    '--color-base-30': '#363636',
    '--color-base-60': '#999999',
    '--color-base-70': '#bababa',
    '--color-base-100': '#dadada',
  },
};

/**
 * Maps Obsidian's theme variables to an xterm theme (D9, R2.8). Background / foreground / cursor / selection come
 * from the editor colors; the ANSI palette from Obsidian's accent colors (no bright variants exist, so bright =
 * normal hue) and the gray scale, chosen per mode so "black" and "white" stay readable: in dark mode white is a
 * light gray, in light mode white is a mid gray (like VS Code's Light+ terminal).
 */
export function buildTheme(read: CssVarReader, dark: boolean): ITheme {
  const fallback = FALLBACK[dark ? 'dark' : 'light'];
  const v = (name: string): string => read(name).trim() || fallback[name] || '';
  const background = v('--background-primary');
  const red = v('--color-red');
  const green = v('--color-green');
  const yellow = v('--color-yellow');
  const blue = v('--color-blue');
  const magenta = v('--color-purple');
  const cyan = v('--color-cyan');
  const palette: Palette = {
    background,
    foreground: v('--text-normal'),
    cursor: v('--text-accent'),
    cursorAccent: background,
    selectionBackground: v('--text-selection'),
    black: dark ? v('--color-base-30') : v('--color-base-100'),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: v('--color-base-70'),
    brightBlack: v('--color-base-60'),
    brightRed: red,
    brightGreen: green,
    brightYellow: dark ? yellow : v('--color-orange'),
    brightBlue: blue,
    brightMagenta: v('--color-pink'),
    brightCyan: cyan,
    brightWhite: dark ? v('--color-base-100') : v('--color-base-50'),
  };
  return { ...palette, selectionInactiveBackground: palette.selectionBackground };
}

/**
 * Solarized palettes by Ethan Schoonover (https://github.com/altercation/solarized, MIT).
 * The foreground is Solarized's own (base0 on dark, base00 on light), yellow and magenta stay in their ANSI slots,
 * bright = normal hue so bold text (drawn in bright colors) keeps its hue, the gray text slots keep at least 3:1
 * contrast with the background, and the dark selection is base1 at 25% so selected text stays readable.
 */
const SOLARIZED: Record<'dark' | 'light', Palette> = {
  dark: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#268bd2',
    cursorAccent: '#002b36',
    selectionBackground: 'rgba(147, 161, 161, 0.25)',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#657b83',
    brightRed: '#dc322f',
    brightGreen: '#859900',
    brightYellow: '#b58900',
    brightBlue: '#268bd2',
    brightMagenta: '#d33682',
    brightCyan: '#2aa198',
    brightWhite: '#fdf6e3',
  },
  light: {
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#268bd2',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#d3cfc1',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#657b83',
    brightBlack: '#586e75',
    brightRed: '#dc322f',
    brightGreen: '#859900',
    brightYellow: '#b58900',
    brightBlue: '#268bd2',
    brightMagenta: '#d33682',
    brightCyan: '#2aa198',
    brightWhite: '#586e75',
  },
};

/**
 * A fixed palette that ignores the Obsidian theme: Obsidian's default dark colors on a pure black background, its
 * default light colors on white, or Solarized dark / light.
 */
export function buildFixedTheme(mode: Exclude<TerminalColors, 'obsidian'>): ITheme {
  if (mode === 'solarized-dark' || mode === 'solarized-light') {
    const palette = SOLARIZED[mode === 'solarized-dark' ? 'dark' : 'light'];
    return { ...palette, selectionInactiveBackground: palette.selectionBackground };
  }
  const theme = buildTheme(() => '', mode === 'dark');
  if (mode === 'dark') return { ...theme, background: '#000000', cursorAccent: '#000000' };
  return theme;
}

/** The xterm theme for `el` under the chosen color mode. */
export function resolveTheme(el: HTMLElement, mode: TerminalColors): ITheme {
  return mode === 'obsidian' ? readObsidianTheme(el) : buildFixedTheme(mode);
}

/** True when Obsidian's dark theme is active in `doc` (`body.theme-dark`). */
export function isDarkTheme(doc: Document): boolean {
  return doc.body?.classList.contains('theme-dark') ?? false;
}

/**
 * The xterm theme for `el`'s window. Variables are resolved through computed style; colors are normalized by the
 * browser (a probe element) so values like `hsla(calc(...), …)` reach xterm as plain `rgb()` / `rgba()`.
 */
export function readObsidianTheme(el: HTMLElement): ITheme {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win) return buildTheme(() => '', false);
  const style = win.getComputedStyle(el);
  const probe = el.createDiv();
  probe.hide();
  try {
    const read: CssVarReader = (name) => {
      const raw = style.getPropertyValue(name).trim();
      if (!raw) return '';
      probe.setCssProps({ color: '' });
      probe.setCssProps({ color: raw });
      const normalized = probe.style.color ? win.getComputedStyle(probe).color : '';
      return normalized || raw;
    };
    return buildTheme(read, isDarkTheme(doc));
  } finally {
    probe.remove();
  }
}
