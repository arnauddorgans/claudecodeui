import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionProcessEvent, SessionProcessSnapshot } from '@/shared/types.js';

/**
 * The single producer of the `session_process` event.
 *
 * A provider that keeps a process alive between turns reports it starting and
 * ending; every chat client hears it, so a session's dot can say where the
 * session lives without asking. `chat_subscribed` carries the same snapshot
 * for a client arriving later.
 */
export function buildSessionProcessEvent(snapshot: SessionProcessSnapshot): SessionProcessEvent {
  return {
    ...snapshot,
    kind: 'session_process',
    timestamp: new Date().toISOString(),
  };
}

export function broadcastSessionProcess(snapshot: SessionProcessSnapshot): void {
  const payload = JSON.stringify(buildSessionProcessEvent(snapshot));
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

/**
 * Forwards every process change of every provider to the chat clients.
 * @returns the unsubscribe
 */
export function startSessionProcessBroadcast(
  source: { onSessionProcessChange(listener: (snapshot: SessionProcessSnapshot) => void): () => void },
): () => void {
  return source.onSessionProcessChange(broadcastSessionProcess);
}
