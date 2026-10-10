// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinkActivator, isWebUrl, openInBrowser } from '../../src/terminal/links';
import { buildFixedTheme, buildTheme, isDarkTheme, readObsidianTheme } from '../../src/terminal/theme';

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

afterEach(() => {
  document.body.className = '';
  document.body.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('theme mapping (D9, R2.8)', () => {
  it('maps the light theme', () => {
    const t = buildTheme((n) => OBSIDIAN_LIGHT[n] ?? '', false);
    expect(t).toMatchObject({
      background: '#ffffff',
      foreground: '#222222',
      cursor: '#8a5cf5',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(138, 92, 245, 0.2)',
      selectionInactiveBackground: 'rgba(138, 92, 245, 0.2)',
      black: '#222222',
      white: '#5a5a5a',
      brightBlack: '#707070',
      brightWhite: '#ababab',
      red: '#e93147',
      magenta: '#7852ee',
      brightMagenta: '#d53984',
      brightYellow: '#ec7500',
    });
  });

  it('maps the dark theme so black / white stay readable on the dark background', () => {
    const t = buildTheme((n) => OBSIDIAN_DARK[n] ?? '', true);
    expect(t).toMatchObject({
      background: '#1e1e1e',
      foreground: '#dadada',
      black: '#363636',
      white: '#bababa',
      brightBlack: '#999999',
      brightWhite: '#dadada',
      yellow: '#e0de71',
      brightYellow: '#e0de71',
      cyan: '#53dfdd',
    });
  });

  it('falls back to Obsidian defaults when a theme leaves variables unset', () => {
    const light = buildTheme(() => '', false);
    const dark = buildTheme(() => '', true);
    expect(light.background).toBe('#ffffff');
    expect(dark.background).toBe('#1e1e1e');
    for (const t of [light, dark]) for (const v of Object.values(t)) expect(v).toMatch(/^(#|rgba?\()/);
  });

  it('reads variables through computed style and detects dark mode from body.theme-dark', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.style.setProperty('--background-primary', '#102030');
    el.style.setProperty('--text-normal', '#e0e0e0');
    expect(isDarkTheme(document)).toBe(false);
    document.body.classList.add('theme-dark');
    expect(isDarkTheme(document)).toBe(true);
    const t = readObsidianTheme(el);
    expect(t.background === '#102030' || t.background === 'rgb(16, 32, 48)').toBe(true);
    expect(t.black).toBe('#363636');
    el.remove();
  });
});

describe('web links (R2.9)', () => {
  it('accepts only http(s) URLs', () => {
    expect(isWebUrl('https://example.com/a?b=c')).toBe(true);
    expect(isWebUrl('http://localhost:3000')).toBe(true);
    expect(isWebUrl('file:///etc/passwd')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('not a url')).toBe(false);
  });

  it('Cmd-click opens the URL in the default browser; a plain click does nothing', () => {
    const open = vi.fn();
    const activate = createLinkActivator(() => window, open);
    activate(new MouseEvent('click'), 'https://example.com');
    expect(open).not.toHaveBeenCalled();
    activate(new MouseEvent('click', { metaKey: true }), 'https://example.com');
    expect(open).toHaveBeenCalledWith('https://example.com', window);
    activate(new MouseEvent('click', { metaKey: true }), 'file:///tmp/x');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('opens through window.open with the _external frame (skips the Web viewer)', () => {
    const win = { open: vi.fn() } as unknown as Window;
    openInBrowser('https://example.com', win);
    expect(win.open).toHaveBeenCalledWith('https://example.com', '_external');
  });
});

describe('fixed terminal colors (Terminal colors setting)', () => {
  it('Dark is a black background with light text; Light is white with dark text', () => {
    const dark = buildFixedTheme('dark');
    expect(dark.background).toBe('#000000');
    expect(dark.cursorAccent).toBe('#000000');
    expect(dark.foreground).toBe('#dadada');
    const light = buildFixedTheme('light');
    expect(light.background).toBe('#ffffff');
    expect(light.foreground).toBe('#222222');
  });
});
