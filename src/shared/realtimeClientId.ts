/**
 * This tab's name for itself on the chat socket and on the requests whose
 * progress that socket reports (`GET /api/projects`), so the server sends a
 * request's `loading_progress` to the tab that made it instead of to every
 * connected client. One per page load; a reconnecting socket keeps it.
 */
const createClientId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

export const REALTIME_CLIENT_ID = createClientId();
