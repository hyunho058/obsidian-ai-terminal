/** Only web URLs are opened from terminal output (never `file:`, `javascript:` …). */
export function isWebUrl(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Opens a URL in the default browser. Obsidian's window-open handler sends http(s) URLs to `shell.openExternal`;
 * the frame name `_external` skips the Web viewer core plugin, which would otherwise open it inside Obsidian.
 */
export function openInBrowser(url: string, win: Window): void {
  win.open(url, '_external');
}

/**
 * Link activation for addon-web-links and OSC 8 links (R2.9): Cmd-click opens web URLs; a plain click stays a
 * terminal click (selection / mouse reporting).
 */
export function createLinkActivator(getWindow: () => Window, open: (url: string, win: Window) => void = openInBrowser) {
  return (event: MouseEvent, uri: string): void => {
    if (!event.metaKey || !isWebUrl(uri)) return;
    event.preventDefault?.();
    open(uri, getWindow());
  };
}
