import { ButtonComponent, Modal, type App } from 'obsidian';

/** `enable` → stored true · `decline` → stored false · `dismiss` (closed / timed out) → stays null, asked again next launch. */
export type FirstUseAnswer = 'enable' | 'decline' | 'dismiss';

export const FIRST_USE_QUESTION = 'Enable AI session snapshots for this vault?';
/** A spawn never waits longer than this for the answer (e.g. a modal hidden behind another window). */
export const FIRST_USE_TIMEOUT_MS = 10 * 60_000;

/** R12.1 — "Enable AI session snapshots for this vault?" [Enable] [Don't enable]; closing it is a dismiss. */
export class EnableSnapshotsModal extends Modal {
  enableButton: ButtonComponent | null = null;
  declineButton: ButtonComponent | null = null;
  private answered = false;

  constructor(
    app: App,
    private readonly answer: (answer: FirstUseAnswer) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ai-terminal-snapshot-dialog');
    this.setTitle(FIRST_USE_QUESTION);
    contentEl.createEl('p', {
      text:
        'Before every message you send to Claude Code or Antigravity, AI Terminal saves a restore point of your notes ' +
        '(.md, .canvas, .base). It is stored outside the vault, in ~/.local/share/obsidian-ai-terminal.',
    });
    contentEl.createEl('p', { text: 'Use "Restore notes from before an AI session…" to bring notes back. You can change this in Settings.' });
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    this.enableButton = new ButtonComponent(buttons)
      .setButtonText('Enable')
      .setCta()
      .onClick(() => this.choose('enable'));
    this.declineButton = new ButtonComponent(buttons).setButtonText("Don't enable").onClick(() => this.choose('decline'));
    this.enableButton.buttonEl?.focus?.();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) {
      this.answered = true;
      this.answer('dismiss');
    }
  }

  choose(answer: FirstUseAnswer): void {
    if (this.answered) return;
    this.answered = true;
    this.answer(answer);
    this.close();
  }
}

/** Opens the question; `answer` is called exactly once. Returns a handle to close it (= dismiss). */
export type OpenFirstUseModal = (answer: (answer: FirstUseAnswer) => void) => { close(): void };

export function openEnableSnapshotsModal(app: App): OpenFirstUseModal {
  return (answer) => {
    const modal = new EnableSnapshotsModal(app, answer);
    modal.open();
    return modal;
  };
}

export interface FirstUsePromptOptions {
  open: OpenFirstUseModal;
  /** Stores the answer (runs once per question, before every asker gets it). */
  apply: (answer: FirstUseAnswer) => Promise<void> | void;
  timeoutMs?: number;
}

/**
 * Asks the first-use question. Spawns that ask while the dialog is open share it (several AI panels restored at
 * startup → one dialog). Timeout or `dispose()` count as dismiss.
 */
export class FirstUsePrompt {
  private pending: Promise<FirstUseAnswer> | null = null;
  private handle: { close(): void } | null = null;
  private disposed = false;

  constructor(private readonly opts: FirstUsePromptOptions) {}

  /** True while the question is on screen. */
  isAsking(): boolean {
    return this.pending !== null;
  }

  ask(): Promise<FirstUseAnswer> {
    if (this.disposed) return Promise.resolve('dismiss');
    if (this.pending) return this.pending;
    const answered = new Promise<FirstUseAnswer>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (answer: FirstUseAnswer): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        const h = this.handle;
        this.handle = null;
        resolve(answer);
        if (answer === 'dismiss') h?.close();
      };
      timer = setTimeout(() => finish('dismiss'), this.opts.timeoutMs ?? FIRST_USE_TIMEOUT_MS);
      try {
        const h = this.opts.open(finish);
        if (!done) this.handle = h;
      } catch {
        finish('dismiss');
      }
    });
    const pending = answered
      .then(async (answer) => {
        try {
          await this.opts.apply(answer);
        } catch {
          // the answer still counts for this spawn
        }
        return answer;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }

  /** Plugin unload: closes an open question (= dismiss). */
  dispose(): void {
    this.disposed = true;
    this.handle?.close();
  }
}
