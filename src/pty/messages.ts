import type { PtyExit } from './PtyProcess';

/** R3.4: printed in the panel (before the exit prompt) when the profile's command does not exist. */
export function formatCommandNotFound(command: string): string {
  return `Command not found: ${command} — check Settings › Profiles`;
}

/**
 * The line to print when a session ended because it could not start (command missing / not executable,
 * helper failed to launch), or null for an ordinary exit.
 */
export function formatSpawnFailure(exit: PtyExit): string | null {
  if (exit.notFound) return formatCommandNotFound(exit.command);
  if (exit.execError) return `Cannot run ${exit.command}: ${exit.execError.message} — check Settings › Profiles`;
  if (exit.error) return `Could not start the terminal helper: ${exit.error.message}`;
  return null;
}
