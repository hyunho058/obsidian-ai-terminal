import type { FeatureModule } from '../core';
import { notice } from '../util/log';
import { ShellEnv, type ShellEnvOptions, type ShellEnvStatus } from './shellEnv';

export * from './shellEnv';

/** The `shellEnv` service: the D6 spawn environment. */
export interface ShellEnvService {
  /** `pending` until the login-shell capture finished; `fallback` if it failed or timed out. */
  readonly status: ShellEnvStatus;
  /** PATH of the spawn environment (the login shell's PATH once captured). */
  readonly path: string;
  readonly failureReason: string | undefined;
  /** A fresh copy of the layered spawn environment plus `extra` (`undefined` removes a variable). */
  getSpawnEnv(extra?: Record<string, string | undefined>): Record<string, string>;
  /** Resolves when the capture has finished (it is part of the plugin's ready gate). */
  whenReady(): Promise<void>;
}

declare module '../core/services' {
  interface ServiceMap {
    shellEnv: ShellEnvService;
  }
}

/** R3.3 Notice: one sentence + the fix. The failure reason is in the log (`shellEnv` warns with it). */
export function fallbackNoticeText(): string {
  return 'AI Terminal: could not read your login shell, so a fallback PATH with ~/.local/bin and /opt/homebrew/bin is used. If a program is not found, check Settings › Profiles.';
}

/**
 * T2 — login-shell environment capture and layering (D6, R3). Publishes `shellEnv` in `register`; the
 * capture runs in `ready` (≤ 5 s), so spawns wait for it through the ready gate.
 */
export function createEnvModule(options: ShellEnvOptions = {}): FeatureModule {
  let shellEnv: ShellEnv | undefined;
  return {
    id: 'env',
    label: 'the shell environment',
    register(ctx) {
      shellEnv = new ShellEnv({ log: ctx.log.child('env'), ...options });
      ctx.services.provide('shellEnv', shellEnv);
    },
    async ready() {
      if (!shellEnv) return;
      await shellEnv.capture();
      if (shellEnv.status === 'fallback') notice(fallbackNoticeText(), 10_000);
    },
    unload() {
      shellEnv?.dispose();
    },
  };
}
