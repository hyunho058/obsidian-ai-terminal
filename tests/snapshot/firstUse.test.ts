import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnableSnapshotsModal, FIRST_USE_QUESTION, FIRST_USE_TIMEOUT_MS, FirstUsePrompt, openEnableSnapshotsModal, type FirstUseAnswer } from '../../src/snapshot/firstUse';
import { App as MockApp, Modal } from '../mocks/obsidian';

const app = () => new MockApp('/vault') as unknown as App;

afterEach(() => {
  for (const m of [...Modal.open]) m.close();
  vi.useRealTimers();
});

describe('first-use modal (R12.1)', () => {
  it('asks the question with [Enable] [Don\'t enable]; each answer is reported once', () => {
    for (const [action, expected] of [
      ['enable', 'enable'],
      ['decline', 'decline'],
      ['close', 'dismiss'],
    ] as const) {
      const answers: FirstUseAnswer[] = [];
      const modal = new EnableSnapshotsModal(app(), (a) => answers.push(a));
      modal.open();
      expect(Modal.open).toContain(modal);
      expect((modal as unknown as Modal).titleEl.textContent).toBe(FIRST_USE_QUESTION);
      expect((modal.enableButton as unknown as { text: string }).text).toBe('Enable');
      expect((modal.declineButton as unknown as { text: string }).text).toBe("Don't enable");
      if (action === 'enable') (modal.enableButton as unknown as { click(): void }).click();
      else if (action === 'decline') (modal.declineButton as unknown as { click(): void }).click();
      else modal.close();
      expect(answers).toEqual([expected]);
      expect(Modal.open).not.toContain(modal);
      modal.close();
      expect(answers).toEqual([expected]);
    }
  });

  it('concurrent asks share one dialog; the answer is applied once before every asker gets it', async () => {
    const applied: FirstUseAnswer[] = [];
    const prompt = new FirstUsePrompt({ open: openEnableSnapshotsModal(app()), apply: async (a) => void applied.push(a) });
    const a = prompt.ask();
    const b = prompt.ask();
    expect(prompt.isAsking()).toBe(true);
    expect(Modal.open).toHaveLength(1);
    (Modal.open[0] as unknown as EnableSnapshotsModal).choose('enable');
    expect(await a).toBe('enable');
    expect(await b).toBe('enable');
    expect(applied).toEqual(['enable']);
    expect(prompt.isAsking()).toBe(false);
    // Asked again later (e.g. after a dismiss): a new dialog.
    const c = prompt.ask();
    expect(Modal.open).toHaveLength(1);
    Modal.open[0]!.close();
    expect(await c).toBe('dismiss');
    expect(applied).toEqual(['enable', 'dismiss']);
  });

  it('a spawn never waits forever: the timeout counts as dismiss and closes the dialog', async () => {
    vi.useFakeTimers();
    const prompt = new FirstUsePrompt({ open: openEnableSnapshotsModal(app()), apply: () => {} });
    const answer = prompt.ask();
    expect(Modal.open).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FIRST_USE_TIMEOUT_MS - 1);
    expect(Modal.open).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBe('dismiss');
    expect(Modal.open).toHaveLength(0);
    expect(FIRST_USE_TIMEOUT_MS).toBe(600_000);
  });

  it('dispose (plugin unload) and a failing dialog both count as dismiss', async () => {
    const prompt = new FirstUsePrompt({ open: openEnableSnapshotsModal(app()), apply: () => {} });
    const answer = prompt.ask();
    prompt.dispose();
    expect(await answer).toBe('dismiss');
    expect(Modal.open).toHaveLength(0);
    expect(await prompt.ask()).toBe('dismiss');

    const broken = new FirstUsePrompt({
      open: () => {
        throw new Error('no window');
      },
      apply: () => {
        throw new Error('save failed');
      },
    });
    expect(await broken.ask()).toBe('dismiss');
  });
});
