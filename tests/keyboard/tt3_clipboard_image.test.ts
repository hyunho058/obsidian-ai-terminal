// Acceptance tests for spec paste-image R3 (D4): the Electron clipboard reports whether it holds an image.
import { describe, expect, it } from 'vitest';
import { clipboardFromElectron } from '../../src/terminal/keyboard';

type ElectronArg = Parameters<typeof clipboardFromElectron>[0];

function fakeElectron(opts: { formats?: () => string[]; text?: string } = {}) {
  const written: string[] = [];
  const fake = {
    availableFormats: opts.formats ?? (() => []),
    readText: () => opts.text ?? '',
    writeText: (value: string) => {
      written.push(value);
    },
  };
  return { fake: fake as unknown as ElectronArg, written };
}

describe('R3.1: an image format means hasImage() is true', () => {
  it("returns true for ['image/png']", () => {
    const { fake } = fakeElectron({ formats: () => ['image/png'] });
    expect(clipboardFromElectron(fake).hasImage?.()).toBe(true);
  });

  it("returns true for ['text/plain', 'image/tiff']", () => {
    const { fake } = fakeElectron({ formats: () => ['text/plain', 'image/tiff'] });
    expect(clipboardFromElectron(fake).hasImage?.()).toBe(true);
  });
});

describe('R3.2: no image format means hasImage() is false', () => {
  it("returns false for ['text/plain']", () => {
    const { fake } = fakeElectron({ formats: () => ['text/plain'] });
    const clipboard = clipboardFromElectron(fake);
    expect(typeof clipboard.hasImage).toBe('function');
    expect(clipboard.hasImage?.()).toBe(false);
  });

  it('returns false for []', () => {
    const { fake } = fakeElectron({ formats: () => [] });
    const clipboard = clipboardFromElectron(fake);
    expect(typeof clipboard.hasImage).toBe('function');
    expect(clipboard.hasImage?.()).toBe(false);
  });
});

describe('R3.3: a throwing availableFormats() means hasImage() is false', () => {
  it('returns false and does not throw', () => {
    const { fake } = fakeElectron({
      formats: () => {
        throw new Error('clipboard unavailable');
      },
    });
    const clipboard = clipboardFromElectron(fake);
    expect(typeof clipboard.hasImage).toBe('function');
    let result: boolean | undefined;
    expect(() => {
      result = clipboard.hasImage?.();
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

describe('R3.4: text read and write still go to Electron', () => {
  it("readText() returns 'abc' synchronously and writeText('xyz') reaches the fake", () => {
    const { fake, written } = fakeElectron({ text: 'abc' });
    const clipboard = clipboardFromElectron(fake);
    const text = clipboard.readText();
    expect(text).not.toBeInstanceOf(Promise);
    expect(text).toBe('abc');
    clipboard.writeText('xyz');
    expect(written).toEqual(['xyz']);
  });
});
