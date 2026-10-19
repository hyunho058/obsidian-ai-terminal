// @vitest-environment happy-dom
// Acceptance tests for R2 of specs/paste-image/spec.md (D2): the Shell profile and Ctrl+V are unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep } from '../session/helpers';
import { makeKeyboardHarness, openRunning, press, type KeyboardHarness } from './helpers';

let h: KeyboardHarness | null = null;

afterEach(() => {
  h?.runtime.unload();
  h = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('R2: the Shell profile and Ctrl+V are unchanged (D2)', () => {
  it('R2.1: image-only clipboard in a Shell panel sends nothing', async () => {
    h = await makeKeyboardHarness();
    const { view, proc } = await openRunning(h, 'shell');
    h.clipboard.text = '';
    h.clipboard.image = true;
    const pressed = press(view, { key: 'v', code: 'KeyV', metaKey: true });
    expect(pressed.down.defaultPrevented).toBe(true);
    await sleep(20);
    expect(proc.input()).toBe('');
  });

  it.each(['shell', 'claude'] as const)('R2.2: Ctrl+V still sends \\x16 in a %s panel', async (profile) => {
    h = await makeKeyboardHarness();
    const { view, proc } = await openRunning(h, profile);
    press(view, { key: 'v', code: 'KeyV', ctrlKey: true });
    await sleep(20);
    expect(proc.input()).toBe('\x16');
  });
});
