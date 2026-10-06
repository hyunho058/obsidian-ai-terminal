import type { WorkspaceLeaf } from 'obsidian';
import { TERMINAL_VIEW_TYPE, TypedEmitter, type Disposer, type FeatureModule, type ProfileId } from '../core';
import { openTerminal, registerCommands, type OpenTerminalOptions } from './commands';
import { TerminalView, type TerminalViewHost } from './TerminalView';

export * from './commands';
export * from './links';
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
    register(ctx) {
      const sessions = ctx.services.require('sessions');
      const views = new Set<TerminalView>();
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

      const open = (profile: ProfileId, options?: OpenTerminalOptions) => openTerminal(ctx, profile, options);
      registerCommands(ctx, open);

      ctx.onSettingsChange((s, prev) => {
        const changed =
          s.fontFamily !== prev.fontFamily ||
          s.fontSize !== prev.fontSize ||
          s.scrollback !== prev.scrollback ||
          s.optionIsMeta !== prev.optionIsMeta;
        if (changed) for (const view of views) view.applySettings();
      });

      ctx.services.provide('terminals', {
        open,
        views: () => [...views],
        viewOf: (panelId) => {
          const matching = [...views].filter((v) => v.panelId === panelId);
          return matching.find((v) => v.session !== undefined) ?? matching[0];
        },
        viewOfLeaf: (leaf) => (leaf.view instanceof TerminalView ? leaf.view : undefined),
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
