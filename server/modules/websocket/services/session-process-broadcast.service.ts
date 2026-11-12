import { broadcastToConnectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionProcessEvent, SessionProcessSnapshot } from '@/shared/types.js';

/**
 * The single producer of the `session_process` event.
 *
 * Under `SESSION_PROCESS_CLOSE=manual` a session's process outlives its turns,
 * so every chat client is told when one starts, ends, opens or closes a turn,
 * or starts or ends a task: a session's dot can say where it lives without
 * asking. `chat_subscribed.process` carries the same snapshot for a client
 * arriving later.
 */
export function buildSessionProcessEvent(snapshot: SessionProcessSnapshot): SessionProcessEvent {
  return {
    ...snapshot,
    kind: 'session_process',
    timestamp: new Date().toISOString(),
  };
}

export function broadcastSessionProcess(snapshot: SessionProcessSnapshot): void {
  broadcastToConnectedClients(JSON.stringify(buildSessionProcessEvent(snapshot)));
}

/**
 * Forwards every process change of every provider to the chat clients.
 * @returns the unsubscribe
 */
export function startSessionProcessBroadcast(source: {
  onSessionProcessChange?(listener: (snapshot: SessionProcessSnapshot) => void): () => void;
}): () => void {
  return source.onSessionProcessChange?.(broadcastSessionProcess) ?? (() => {});
}
