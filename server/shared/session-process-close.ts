/**
 * Who closes a session's provider process, for the Claude chat runtime and
 * the terminal's PTY alike. Read from `SESSION_PROCESS_CLOSE`.
 *
 * - `auto` (default): the server does, as CloudCLI always did. The chat
 *   spawns a process per turn, held after the turn only while background
 *   work is outstanding and at most `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` of
 *   silence; the next turn replaces it. A PTY with no client attached is
 *   killed after `PTY_SESSION_TIMEOUT_MS`.
 * - `manual`: nothing closes without a request. One process per session,
 *   kept across turns, ended only by `chat.close`, the CLI exiting, or the
 *   server shutting down; a PTY stays until its shell exits or a client
 *   closes it.
 */
export type SessionProcessClose = 'auto' | 'manual';

export function resolveSessionProcessClose(
  value: string | undefined = process.env.SESSION_PROCESS_CLOSE,
): SessionProcessClose {
  return value?.trim().toLowerCase() === 'manual' ? 'manual' : 'auto';
}

/** `auto`: how long a process held for background work may stay silent before it is let go. */
export const AUTO_BG_WAIT_CEILING_MS = 30 * 60 * 1000;

/** `auto`: how long a PTY outlives its last client. `0` disables the kill. */
export function resolvePtySessionTimeoutMs(
  value: string | undefined = process.env.PTY_SESSION_TIMEOUT_MS,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30 * 60 * 1000;
}
