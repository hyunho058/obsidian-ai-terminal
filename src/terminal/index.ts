import type { WorkspaceLeaf } from 'obsidian';
import { TERMINAL_VIEW_TYPE, TypedEmitter, type Disposer, type FeatureModule, type ProfileId } from '../core';
import { openTerminal, registerCommands, type OpenTerminalOptions } from './commands';
import { registerSendNotePath } from './notePath';
import { TerminalView, type TerminalViewHost } from './TerminalView';

export * from './commands';
export * from './links';
export * from './notePath';
export * from './theme';
export * from './TerminalView';

/** The `terminals` service: open terminal views (T4's close flow, keyboard routing; T10's running-panel list). */
export interface TerminalViewsService {
  /** Opens a new panel (placement from settings unless overridden), reveals and focuses it. */
  open(profile: ProfileId, options?: OpenTerminalOptions): Promise<TerminalView | null>;
  /** Every open (non-deferred) terminal view. */
  views(): TerminalView[];
  /** The view showing `panelId` (the attached one if several claim it). */
  viewOf(panelId: string): TerminalView | undefined;
  /** The terminal view in `leaf`, if any. */
  viewOfLeaf(leaf: WorkspaceLeaf): TerminalView | undefined;
  /** The focused terminal view, else the one focused last, else the newest one. */
  recent(): TerminalView | undefined;
  /** Called once per view when it gets its first state (profile / panelId known, xterm created) — e.g. to set `view.scope`. */
  onViewOpen(listener: (view: TerminalView) => void): Disposer;
  onViewClose(listener: (view: TerminalView) => void): Disposer;
  /**
   * True from the moment Obsidian starts unloading the plugin — before it closes / detaches the terminal leaves
   * (plugin disable detaches them *before* `onunload`, while `ctx.unloading` is still false).
   */
  isTearingDown(): boolean;
}

declare module '../core/services' {
  interface ServiceMap {
    terminals: TerminalViewsService;
  }
}

/**
 * T3 — terminal ItemView (`TERMINAL_VIEW_TYPE`), xterm + addons, theme, commands, ribbon menu, placement.
 * Key events go through `ctx.keyboard.dispatchKey`; sessions live in the `sessions` service.
 */
export function createTerminalModule(): FeatureModule {
  let tearingDown = false;
  return {
    id: 'terminal',
    label: 'terminal panels',
    register(ctx) {
      const sessions = ctx.services.require('sessions');
      const views = new Set<TerminalView>();
      let lastFocused: TerminalView | undefined;
      const events = new TypedEmitter<{ open: TerminalView; close: TerminalView }>((m, e) => ctx.log.error(m, e));
      const isTearingDown = (): boolean => tearingDown || ctx.unloading;
      const host: TerminalViewHost = {
        ctx,
        sessions,
        isTearingDown,
        viewOpened: (view) => {
          views.add(view);
          events.emit('open', view);
        },
        viewClosed: (view) => {
          views.delete(view);
          if (lastFocused === view) lastFocused = undefined;
          events.emit('close', view);
        },
      };
      ctx.plugin.registerView(TERMINAL_VIEW_TYPE, (leaf) => new TerminalView(leaf, host));
      // Plugin cleanups run newest first, so this runs before Obsidian unregisters the view type and (on disable)
      // detaches the terminal leaves: sessions end without any close dialog (R7.7, R7.8).
      ctx.plugin.register(() => {
        tearingDown = true;
        sessions.stopAll('unload');
      });

      ctx.plugin.registerEvent(
        ctx.app.workspace.on('active-leaf-change', (leaf) => {
          if (leaf?.view instanceof TerminalView) lastFocused = leaf.view;
        }),
      );
      const recent = (): TerminalView | undefined => {
        const active = ctx.app.workspace.getActiveViewOfType(TerminalView);
        if (active && views.has(active)) return active;
        if (lastFocused && views.has(lastFocused)) return lastFocused;
        return [...views].pop();
      };

      const open = (profile: ProfileId, options?: OpenTerminalOptions) => openTerminal(ctx, profile, options);
      registerCommands(ctx, open);
      registerSendNotePath(ctx, recent);

      ctx.onSettingsChange((s, prev) => {
        const changed =
          s.fontFamily !== prev.fontFamily ||
          s.fontSize !== prev.fontSize ||
          s.scrollback !== prev.scrollback ||
          s.optionIsMeta !== prev.optionIsMeta;
        if (changed) for (const view of views) view.applySettings();
        if (s.terminalColors !== prev.terminalColors) for (const view of views) view.applyTheme();
      });

      ctx.services.provide('terminals', {
        open,
        views: () => [...views],
        viewOf: (panelId) => {
          const matching = [...views].filter((v) => v.panelId === panelId);
          return matching.find((v) => v.session !== undefined) ?? matching[0];
        },
        viewOfLeaf: (leaf) => (leaf.view instanceof TerminalView ? leaf.view : undefined),
        recent,
        onViewOpen: (listener) => events.on('open', listener),
        onViewClose: (listener) => events.on('close', listener),
        isTearingDown,
      });
    },
    unload() {
      tearingDown = true;
    },
  };
}
