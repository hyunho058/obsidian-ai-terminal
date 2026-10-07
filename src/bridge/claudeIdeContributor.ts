import type { SpawnContributor } from '../core';

/**
 * Port of the IDE server for this session. With it set, Claude Code picks the lock file with that port (skipping the
 * workspace-folder check) and auto-connects (verified with 2.1.292). Inherited values are stripped from the spawn
 * environment (T2), so this contributor is the only source.
 */
export const SSE_PORT_ENV = 'CLAUDE_CODE_SSE_PORT';
export const IDE_FLAG = '--ide';
/** How long a spawn waits for an IDE server that is still starting. */
const START_WAIT_MS = 3000;

/** What the contributor needs from the IDE connection. */
export interface IdeEndpoint {
  readonly port: number | null;
  isRunning(): boolean;
  whenListening(): Promise<void>;
}

/**
 * Spawn contributor for Claude panels (R10.3, R11.1): `--ide` + `CLAUDE_CODE_SSE_PORT=<port>`, so each panel connects to
 * its own vault's server. `getEndpoint` returns undefined while the IDE connection is turned off (R10.10).
 */
export function createClaudeIdeContributor(getEndpoint: () => IdeEndpoint | undefined): SpawnContributor {
  return async (c) => {
    if (c.profile !== 'claude') return;
    const endpoint = getEndpoint();
    if (!endpoint) return;
    if (!endpoint.isRunning() && !(await listensWithin(endpoint, START_WAIT_MS))) return;
    const port = endpoint.port;
    if (port === null) return;
    return {
      args: c.baseArgs.includes(IDE_FLAG) ? [] : [IDE_FLAG],
      env: { [SSE_PORT_ENV]: String(port) },
    };
  };
}

async function listensWithin(endpoint: IdeEndpoint, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([endpoint.whenListening().then(() => true, () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
