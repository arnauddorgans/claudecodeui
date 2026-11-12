/**
 * Who closes a session's provider process, for the Claude chat runtime and the
 * terminal's PTY alike. Read from `SESSION_PROCESS_CLOSE`.
 *
 * - `auto` (default): the server does, as CloudCLI always has. A turn runs in a
 *   process of its own, held after the turn only while background work is
 *   outstanding; the next turn replaces it. A PTY with no client attached is
 *   killed after a while.
 * - `manual`: nothing closes without a request. One process per session, kept
 *   across turns: the next turn is written into its input instead of
 *   replacing it, so background work keeps running. It ends on `chat.close`, a
 *   replace (an edited message, another working directory), the CLI exiting,
 *   or the server shutting down. A PTY stays until its shell exits or a client
 *   closes it.
 */
export type SessionProcessClose = 'auto' | 'manual';

export function resolveSessionProcessClose(
  value: string | undefined = process.env.SESSION_PROCESS_CLOSE,
): SessionProcessClose {
  return value?.trim().toLowerCase() === 'manual' ? 'manual' : 'auto';
}
