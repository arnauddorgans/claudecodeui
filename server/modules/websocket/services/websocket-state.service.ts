import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

/**
 * Chat connections by the id their client chose for itself (`/ws?clientId=`).
 *
 * A frame about one client's own request — `loading_progress` while its
 * `GET /api/projects` runs — goes to that client alone. The HTTP request and
 * the socket are two transports, so the client names itself on both: the same
 * id on the socket's URL and on the request (`?progressClientId=`). A request
 * that names no live socket gets no frames at all.
 */
const connectionsByClientId = new Map<string, RealtimeClientConnection>();
const clientIdByConnection = new WeakMap<RealtimeClientConnection, string>();

/** Short opaque token: letters, digits, `-` and `_`, 8 to 64 of them. */
export function readRealtimeClientId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(trimmed) ? trimmed : null;
}

export function registerRealtimeClientId(connection: RealtimeClientConnection, clientId: string): void {
  connectionsByClientId.set(clientId, connection);
  clientIdByConnection.set(connection, clientId);
}

export function forgetRealtimeClient(connection: RealtimeClientConnection): void {
  const clientId = clientIdByConnection.get(connection);
  if (clientId && connectionsByClientId.get(clientId) === connection) {
    connectionsByClientId.delete(clientId);
  }
  clientIdByConnection.delete(connection);
}

/** The open chat connection a client named, or null. */
export function getRealtimeClient(clientId: string | null | undefined): RealtimeClientConnection | null {
  if (!clientId) {
    return null;
  }
  const connection = connectionsByClientId.get(clientId);
  return connection && connection.readyState === WS_OPEN_STATE ? connection : null;
}
