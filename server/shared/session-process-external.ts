/**
 * Whether a session's process snapshot names the OS processes still running
 * under the session's CLI after a turn ends — a screen recording, a nested
 * `claude` run, an Xcode build started through the shell. The SDK only knows
 * about tasks it declared (subagents, backgrounded bash); anything else a
 * turn started as a plain child process is invisible once `turnActive` goes
 * false. Read from `SESSION_PROCESS_EXTERNAL_PROCESSES`.
 *
 * Off by default: it costs a `ps` read per snapshot (cached briefly, see
 * `shared/external-process-tree.ts`) and names things — screen recorders,
 * build tools — an operator may not expect a chat client to see, so this
 * stays opt-in while it is proposed upstream.
 */
export function resolveSessionProcessExternalProcessesEnabled(
  value: string | undefined = process.env.SESSION_PROCESS_EXTERNAL_PROCESSES,
): boolean {
  return value?.trim().toLowerCase() === 'true';
}
