/**
 * How long a session's provider process lives, for the Claude chat runtime
 * and the terminal's PTY alike. Read from `SESSION_PROCESS_LIFETIME`.
 *
 * - `classic` (default): what CloudCLI always did. The chat spawns a process
 *   per turn, held after the turn only while background work is outstanding
 *   and at most `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` of silence; the next
 *   turn replaces it. A PTY with no client attached is killed after
 *   `PTY_SESSION_TIMEOUT_MS`.
 * - `forever`: one process per session, kept across turns, ended only by
 *   `chat.close`, the CLI exiting, or the server shutting down; a PTY stays
 *   until its shell exits or a client closes it.
 */
export type SessionProcessLifetime = 'classic' | 'forever';

export function resolveSessionProcessLifetime(
  value: string | undefined = process.env.SESSION_PROCESS_LIFETIME,
): SessionProcessLifetime {
  return value?.trim().toLowerCase() === 'forever' ? 'forever' : 'classic';
}

/** How long a held classic process may stay silent before it is let go. */
export const CLASSIC_BG_WAIT_CEILING_MS = 30 * 60 * 1000;

/** How long a classic PTY outlives its last client. `0` disables the kill. */
export function resolvePtySessionTimeoutMs(
  value: string | undefined = process.env.PTY_SESSION_TIMEOUT_MS,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30 * 60 * 1000;
}
