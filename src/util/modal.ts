import type { Modal } from 'obsidian';

interface ActiveWindowGlobals {
  activeWindow?: Window;
  activeDocument?: Document;
}

/**
 * Opens `modal` in `win`. Obsidian's Modal attaches to the focused window (`activeWindow`); that normally already is the
 * panel's window (the user just clicked or typed there) — if not, point it there for the duration of `open()`.
 */
export function openModalIn(modal: Modal, win: Window | null): void {
  const g = window as ActiveWindowGlobals;
  const previous = { win: g.activeWindow, doc: g.activeDocument };
  const swap = !!win && !!previous.win && win !== previous.win && !win.closed;
  if (swap) {
    g.activeWindow = win!;
    g.activeDocument = win.document;
  }
  try {
    modal.open();
  } finally {
    if (swap) {
      g.activeWindow = previous.win;
      g.activeDocument = previous.doc;
    }
  }
}
