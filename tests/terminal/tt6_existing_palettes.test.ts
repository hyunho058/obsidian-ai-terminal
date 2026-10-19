// TT6 — R6.1 (D5): Dark, Light and Follow Obsidian keep the values they had before the Solarized change.
// Expected values are pinned from buildFixedTheme / buildTheme on the tree before the change.
import { describe, expect, it } from 'vitest';
import { buildFixedTheme, buildTheme } from '../../src/terminal/theme';

const OBSIDIAN_LIGHT: Record<string, string> = {
  '--background-primary': '#ffffff',
  '--text-normal': '#222222',
  '--text-accent': '#8a5cf5',
  '--text-selection': 'rgba(138, 92, 245, 0.2)',
  '--color-red': '#e93147',
  '--color-green': '#08b94e',
  '--color-yellow': '#e0ac00',
  '--color-orange': '#ec7500',
  '--color-blue': '#086ddd',
  '--color-purple': '#7852ee',
  '--color-pink': '#d53984',
  '--color-cyan': '#00bfbc',
  '--color-base-50': '#ababab',
  '--color-base-60': '#707070',
  '--color-base-70': '#5a5a5a',
  '--color-base-100': '#222222',
};

const OBSIDIAN_DARK: Record<string, string> = {
  '--background-primary': '#1e1e1e',
  '--text-normal': '#dadada',
  '--text-accent': '#a68af9',
  '--text-selection': 'rgba(138, 92, 245, 0.3)',
  '--color-red': '#fb464c',
  '--color-green': '#44cf6e',
  '--color-yellow': '#e0de71',
  '--color-blue': '#027aff',
  '--color-purple': '#a882ff',
  '--color-pink': '#fa99cd',
  '--color-cyan': '#53dfdd',
  '--color-base-30': '#363636',
  '--color-base-60': '#999999',
  '--color-base-70': '#bababa',
  '--color-base-100': '#dadada',
};

const DARK_BEFORE = {
  background: '#000000',
  foreground: '#dadada',
  cursor: '#a68af9',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(138, 92, 245, 0.35)',
  black: '#363636',
  red: '#fb464c',
  green: '#44cf6e',
  yellow: '#e0de71',
  blue: '#027aff',
  magenta: '#a882ff',
  cyan: '#53dfdd',
  white: '#bababa',
  brightBlack: '#999999',
  brightRed: '#fb464c',
  brightGreen: '#44cf6e',
  brightYellow: '#e0de71',
  brightBlue: '#027aff',
  brightMagenta: '#fa99cd',
  brightCyan: '#53dfdd',
  brightWhite: '#dadada',
  selectionInactiveBackground: 'rgba(138, 92, 245, 0.35)',
};

const LIGHT_BEFORE = {
  background: '#ffffff',
  foreground: '#222222',
  cursor: '#8a5cf5',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(138, 92, 245, 0.25)',
  black: '#222222',
  red: '#e93147',
  green: '#08b94e',
  yellow: '#e0ac00',
  blue: '#086ddd',
  magenta: '#7852ee',
  cyan: '#00bfbc',
  white: '#5a5a5a',
  brightBlack: '#707070',
  brightRed: '#e93147',
  brightGreen: '#08b94e',
  brightYellow: '#ec7500',
  brightBlue: '#086ddd',
  brightMagenta: '#d53984',
  brightCyan: '#00bfbc',
  brightWhite: '#ababab',
  selectionInactiveBackground: 'rgba(138, 92, 245, 0.25)',
};

const OBSIDIAN_LIGHT_BEFORE = {
  background: '#ffffff',
  foreground: '#222222',
  cursor: '#8a5cf5',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(138, 92, 245, 0.2)',
  black: '#222222',
  red: '#e93147',
  green: '#08b94e',
  yellow: '#e0ac00',
  blue: '#086ddd',
  magenta: '#7852ee',
  cyan: '#00bfbc',
  white: '#5a5a5a',
  brightBlack: '#707070',
  brightRed: '#e93147',
  brightGreen: '#08b94e',
  brightYellow: '#ec7500',
  brightBlue: '#086ddd',
  brightMagenta: '#d53984',
  brightCyan: '#00bfbc',
  brightWhite: '#ababab',
  selectionInactiveBackground: 'rgba(138, 92, 245, 0.2)',
};

const OBSIDIAN_DARK_BEFORE = {
  background: '#1e1e1e',
  foreground: '#dadada',
  cursor: '#a68af9',
  cursorAccent: '#1e1e1e',
  selectionBackground: 'rgba(138, 92, 245, 0.3)',
  black: '#363636',
  red: '#fb464c',
  green: '#44cf6e',
  yellow: '#e0de71',
  blue: '#027aff',
  magenta: '#a882ff',
  cyan: '#53dfdd',
  white: '#bababa',
  brightBlack: '#999999',
  brightRed: '#fb464c',
  brightGreen: '#44cf6e',
  brightYellow: '#e0de71',
  brightBlue: '#027aff',
  brightMagenta: '#fa99cd',
  brightCyan: '#53dfdd',
  brightWhite: '#dadada',
  selectionInactiveBackground: 'rgba(138, 92, 245, 0.3)',
};

const OBSIDIAN_EMPTY_LIGHT_BEFORE = {
  background: '#ffffff',
  foreground: '#222222',
  cursor: '#8a5cf5',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(138, 92, 245, 0.25)',
  black: '#222222',
  red: '#e93147',
  green: '#08b94e',
  yellow: '#e0ac00',
  blue: '#086ddd',
  magenta: '#7852ee',
  cyan: '#00bfbc',
  white: '#5a5a5a',
  brightBlack: '#707070',
  brightRed: '#e93147',
  brightGreen: '#08b94e',
  brightYellow: '#ec7500',
  brightBlue: '#086ddd',
  brightMagenta: '#d53984',
  brightCyan: '#00bfbc',
  brightWhite: '#ababab',
  selectionInactiveBackground: 'rgba(138, 92, 245, 0.25)',
};

const OBSIDIAN_EMPTY_DARK_BEFORE = {
  background: '#1e1e1e',
  foreground: '#dadada',
  cursor: '#a68af9',
  cursorAccent: '#1e1e1e',
  selectionBackground: 'rgba(138, 92, 245, 0.35)',
  black: '#363636',
  red: '#fb464c',
  green: '#44cf6e',
  yellow: '#e0de71',
  blue: '#027aff',
  magenta: '#a882ff',
  cyan: '#53dfdd',
  white: '#bababa',
  brightBlack: '#999999',
  brightRed: '#fb464c',
  brightGreen: '#44cf6e',
  brightYellow: '#e0de71',
  brightBlue: '#027aff',
  brightMagenta: '#fa99cd',
  brightCyan: '#53dfdd',
  brightWhite: '#dadada',
  selectionInactiveBackground: 'rgba(138, 92, 245, 0.35)',
};

describe('R6.1: Dark, Light and Follow Obsidian keep their values', () => {
  it('buildFixedTheme("dark") returns the same palette as before', () => {
    expect(buildFixedTheme('dark')).toEqual(DARK_BEFORE);
  });

  it('buildFixedTheme("light") returns the same palette as before', () => {
    expect(buildFixedTheme('light')).toEqual(LIGHT_BEFORE);
  });

  it('buildTheme(read, false) maps an Obsidian light theme to the same palette as before', () => {
    expect(buildTheme((n) => OBSIDIAN_LIGHT[n] ?? '', false)).toEqual(OBSIDIAN_LIGHT_BEFORE);
  });

  it('buildTheme(read, true) maps an Obsidian dark theme to the same palette as before', () => {
    expect(buildTheme((n) => OBSIDIAN_DARK[n] ?? '', true)).toEqual(OBSIDIAN_DARK_BEFORE);
  });

  it('buildTheme falls back to the same defaults as before when variables are unset', () => {
    expect(buildTheme(() => '', false)).toEqual(OBSIDIAN_EMPTY_LIGHT_BEFORE);
    expect(buildTheme(() => '', true)).toEqual(OBSIDIAN_EMPTY_DARK_BEFORE);
  });
});
