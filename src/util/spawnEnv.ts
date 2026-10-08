import type { PluginContext } from '../core';

/** The environment a spawned program will see (login-shell layer), so e.g. `$CLAUDE_CONFIG_DIR` from the user's profile counts. */
export function spawnEnv(ctx: Pick<PluginContext, 'services'>): Readonly<Record<string, string | undefined>> {
  try {
    return ctx.services.get('shellEnv')?.getSpawnEnv() ?? process.env;
  } catch {
    return process.env;
  }
}
