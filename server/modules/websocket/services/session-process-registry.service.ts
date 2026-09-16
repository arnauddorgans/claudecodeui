import { broadcastSessionProcess } from '@/modules/websocket/services/session-process-broadcast.service.js';
import type { LLMProvider, SessionProcessSnapshot } from '@/shared/types.js';

/**
 * Where each session lives: in a chat process, kept by its provider runtime,
 * or in a terminal, a PTY of `/shell` with the provider's CLI resumed inside.
 * The two cannot share a process (the interactive CLI has no control
 * channel), so a session is in one place at a time and every client is told
 * which through `session_process`.
 *
 * Chat processes are the providers' own; this registry only keeps the
 * terminals, and merges the two views for `chat_subscribed`, the broadcast and
 * `/sessions/running`.
 */
type TerminalEntry = {
  sessionId: string;
  provider: LLMProvider;
  since: number;
};

const terminals = new Map<string, TerminalEntry>();

function snapshotOf(entry: TerminalEntry, state: 'terminal' | 'off'): SessionProcessSnapshot {
  return {
    sessionId: entry.sessionId,
    provider: entry.provider,
    state,
    since: entry.since,
    providerSessionId: null,
    turnActive: false,
  };
}

export const sessionProcessRegistry = {
  /** A terminal resumed the session: announced to every client. */
  terminalOpened(sessionId: string, provider: LLMProvider): void {
    if (terminals.has(sessionId)) {
      return;
    }
    const entry = { sessionId, provider, since: Date.now() };
    terminals.set(sessionId, entry);
    broadcastSessionProcess(snapshotOf(entry, 'terminal'));
  },

  /** The terminal's shell exited or was killed. A no-op for a session with no terminal. */
  terminalClosed(sessionId: string): void {
    const entry = terminals.get(sessionId);
    if (!entry) {
      return;
    }
    terminals.delete(sessionId);
    broadcastSessionProcess(snapshotOf(entry, 'off'));
  },

  isInTerminal(sessionId: string): boolean {
    return terminals.has(sessionId);
  },

  /** The session's process, the terminal first: a chat process cannot coexist with it. */
  get(sessionId: string, chat: (sessionId: string) => SessionProcessSnapshot | null): SessionProcessSnapshot | null {
    const entry = terminals.get(sessionId);
    return entry ? snapshotOf(entry, 'terminal') : chat(sessionId);
  },

  list(chat: SessionProcessSnapshot[]): SessionProcessSnapshot[] {
    return [
      ...Array.from(terminals.values()).map((entry) => snapshotOf(entry, 'terminal')),
      ...chat.filter((snapshot) => !terminals.has(snapshot.sessionId)),
    ];
  },

  /** Test-only escape hatch. */
  clearAll(): void {
    terminals.clear();
  },
};
