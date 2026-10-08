import type { FeatureModule } from '../core';
import { spawnEnv } from '../util/spawnEnv';
import { createResumeContributor, type ResumeDeps } from './resume';
import { claudeConfigDir } from './resumeTranscript';

/**
 * T5 — conversation identity and resume (D21, D22), registered with `ctx.spawn.add('resume', …)`:
 * Claude `--session-id` / `--resume` / new id + notice (stored by the launcher via `SpawnPlan.sessionId`),
 * Antigravity `--continue` with a one-shot fallback to plain `agy`.
 */
export function createResumeModule(options: Partial<Omit<ResumeDeps, 'log'>> = {}): FeatureModule {
  return {
    id: 'resume',
    label: 'conversation resume',
    register(ctx) {
      const contributor = createResumeContributor({
        log: ctx.log.child('resume'),
        configDir: () => claudeConfigDir(spawnEnv(ctx)),
        ...options,
      });
      ctx.onUnload(ctx.spawn.add('resume', contributor));
    },
  };
}
