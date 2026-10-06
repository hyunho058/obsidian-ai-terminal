import type { ProfileId } from './constants';
import type { Disposer, SpawnPhase } from './types';

/** What a contributor knows about the spawn it is contributing to. */
export interface SpawnContext {
  profile: ProfileId;
  panelId: string;
  /** Current conversation id from the view state (Claude panels), if any. */
  sessionId?: string;
  vaultPath: string;
  phase: SpawnPhase;
  /** The profile's command from settings (e.g. `claude`). */
  command: string;
  /** The profile's arguments from settings, already split (e.g. `['--model', 'sonnet']`). */
  baseArgs: readonly string[];
}

/** A contributor's additions to one spawn. All fields are optional. */
export interface SpawnContribution {
  /** Appended after the base arguments, in contributor registration order. */
  args?: string[];
  /** Merged into the spawn environment; on key conflicts the later contributor wins. */
  env?: Record<string, string>;
  /**
   * Replaces the base arguments (`SpawnContext.baseArgs`); appended `args` of all contributors still follow.
   * Include `baseArgs` yourself to keep the user's arguments, e.g. `[...ctx.baseArgs, '--resume', id]`.
   * If several contributors set it, the last one wins.
   */
  replaceArgs?: string[];
  /** One line printed in the panel before the program starts. */
  notice?: string;
  /** The conversation id the panel should store in its view state (last one wins). */
  sessionId?: string;
  /**
   * One-shot retry: if the program exits with a non-zero code within `withinMs` of starting, the launcher
   * prints `notice` and respawns once with `replaceArgs` in place of the base arguments (contributed args and
   * env are reused; contributors are not run again). Used for `agy --continue` → plain `agy`. Last one wins.
   */
  fallback?: { withinMs: number; replaceArgs: string[]; notice?: string };
}

export type SpawnContributor = (ctx: SpawnContext) => Promise<SpawnContribution | void> | SpawnContribution | void;

/** Result of applying every contributor to a spawn. */
export interface SpawnPlan {
  command: string;
  /** `(last replaceArgs ?? baseArgs) ++ args of every contributor in registration order`. */
  args: string[];
  /** Contributed variables only; the launcher layers them on top of the base spawn environment (contributed wins). */
  env: Record<string, string>;
  /** Lines to print in the panel before spawning, in contributor order. */
  notices: string[];
  /** Conversation id to store in the view state (contributed, else the incoming one). */
  sessionId?: string;
  /** Fully resolved fallback spawn: `args` = fallback.replaceArgs ++ contributed args. */
  fallback?: { withinMs: number; args: string[]; notice?: string };
}

type Named = { name: string; fn: SpawnContributor };
type ErrorReporter = (message: string, err?: unknown) => void;

/**
 * Per-profile spawn additions (args / env / notices) contributed by feature modules.
 * T3's launcher calls `resolve()` for every spawn, after the `beforeSpawn` hooks.
 */
export class SpawnContributorRegistry {
  private readonly contributors: Named[] = [];

  constructor(private readonly report: ErrorReporter = (m, e) => console.error(m, e)) {}

  /**
   * Registers a contributor. They run sequentially in registration order (= module order in main.ts),
   * so appended args keep that order. Return nothing to contribute nothing (e.g. for other profiles).
   */
  add(name: string, contributor: SpawnContributor): Disposer {
    const entry: Named = { name, fn: contributor };
    this.contributors.push(entry);
    return () => {
      const i = this.contributors.indexOf(entry);
      if (i >= 0) this.contributors.splice(i, 1);
    };
  }

  names(): string[] {
    return this.contributors.map((c) => c.name);
  }

  /**
   * Runs every contributor and merges the results. A contributor that throws is reported and skipped —
   * it never blocks the spawn.
   */
  async resolve(ctx: SpawnContext): Promise<SpawnPlan> {
    const frozen: SpawnContext = { ...ctx, baseArgs: Object.freeze([...ctx.baseArgs]) };
    const appended: string[] = [];
    const env: Record<string, string> = {};
    const notices: string[] = [];
    let replaceArgs: string[] | undefined;
    let replacedBy: string | undefined;
    let sessionId = ctx.sessionId;
    let fallback: SpawnContribution['fallback'];

    for (const { name, fn } of [...this.contributors]) {
      let c: SpawnContribution | void;
      try {
        c = await fn(frozen);
      } catch (err) {
        this.report(`spawn contributor "${name}" failed`, err);
        continue;
      }
      if (!c) continue;
      if (c.replaceArgs) {
        if (replacedBy) this.report(`spawn contributor "${name}" overrides replaceArgs from "${replacedBy}"`);
        replaceArgs = [...c.replaceArgs];
        replacedBy = name;
      }
      if (c.args) appended.push(...c.args);
      if (c.env) Object.assign(env, c.env);
      if (c.notice) notices.push(c.notice);
      if (c.sessionId) sessionId = c.sessionId;
      if (c.fallback) fallback = c.fallback;
    }

    const plan: SpawnPlan = {
      command: ctx.command,
      args: [...(replaceArgs ?? ctx.baseArgs), ...appended],
      env,
      notices,
    };
    if (sessionId !== undefined) plan.sessionId = sessionId;
    if (fallback) {
      plan.fallback = { withinMs: fallback.withinMs, args: [...fallback.replaceArgs, ...appended] };
      if (fallback.notice !== undefined) plan.fallback.notice = fallback.notice;
    }
    return plan;
  }
}
