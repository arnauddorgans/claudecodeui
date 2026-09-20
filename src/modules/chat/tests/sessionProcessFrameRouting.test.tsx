import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * Not every frame on the chat socket is a message. The gateway's
 * `session_process` says where a session's process lives and what it is
 * running; it carries no `id` because it is not a transcript row. Routing used
 * to name the frames it did *not* store, so any kind added server-side fell
 * through into the session store, and the merge that reconciles live rows with
 * history threw on the missing `id` — on every later append, fetch and refresh
 * too, since the merge runs over the whole array. Conversations stopped
 * loading and sending until the page was reloaded.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const row = (id: string, content: string, role: 'user' | 'assistant'): NormalizedMessage => ({
  id,
  kind: 'text',
  role,
  provider: 'claude',
  sessionId: 'viewed-session',
  content,
  timestamp: `2026-01-01T00:00:0${id}.000Z`,
} as NormalizedMessage);

const HISTORY = [row('1', 'a question', 'user'), row('2', 'an answer', 'assistant')];

/** The live frame as the gateway broadcasts it: a process snapshot, no `id`. */
const sessionProcessFrame = (state: 'chat' | 'off'): ServerEvent => ({
  kind: 'session_process',
  sessionId: 'viewed-session',
  provider: 'claude',
  state,
  since: 1767225600000,
  providerSessionId: 'claude-abc',
  turnActive: false,
  tasks: [],
  externalProcesses: [],
  timestamp: '2026-01-01T00:00:05.000Z',
} as unknown as ServerEvent);

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages: HISTORY, total: HISTORY.length, hasMore: false } }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const renderChat = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const activity: Array<{ statusText?: string | null }> = [];

  const view = renderHook(() => {
    const sessionStore = useSessionStore();
    useChatRealtimeHandlers({
      isActive: true,
      subscribe: (fn) => {
        listener = fn;
        return () => { listener = null; };
      },
      provider: 'claude',
      selectedSession: { id: 'viewed-session' } as ProjectSession,
      currentSessionId: 'viewed-session',
      setTokenBudget: () => {},
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {},
      streamTimerRef: { current: null },
      accumulatedStreamRef: { current: '' },
      lastSeqRef: { current: new Map() },
      statusCheckSentAtRef: { current: new Map() },
      onSessionProcessing: (_sessionId, next) => { activity.push(next ?? {}); },
      requestLatestMessages: async () => {},
      sessionStore,
    });
    return sessionStore;
  });

  return { view, activity, dispatch: (event: ServerEvent) => listener?.(event) };
};

const loadedChat = async () => {
  const chat = renderChat();
  await act(async () => {
    await chat.view.result.current.fetchFromServer('viewed-session', { limit: 20, offset: 0 });
  });
  return chat;
};

describe('a frame that is not a transcript row', () => {
  it('leaves a loaded conversation exactly as it was', async () => {
    const { view, dispatch } = await loadedChat();

    act(() => {
      dispatch(sessionProcessFrame('chat'));
      dispatch(sessionProcessFrame('off'));
    });

    assert.deepEqual(
      view.result.current.getMessages('viewed-session').map((message) => message.content),
      ['a question', 'an answer'],
    );
  });

  it('does not stop the frames that come after it', async () => {
    const { view, dispatch } = await loadedChat();

    // The poison was never the frame itself: it sat in the live array and
    // threw again on every recompute, so the next reply never rendered and the
    // next refresh failed too.
    act(() => {
      dispatch(sessionProcessFrame('chat'));
      dispatch({
        kind: 'text',
        id: 'live-3',
        sessionId: 'viewed-session',
        provider: 'claude',
        role: 'assistant',
        content: 'a live reply',
        timestamp: '2026-01-01T00:00:06.000Z',
      } as unknown as ServerEvent);
    });

    assert.deepEqual(
      view.result.current.getMessages('viewed-session').map((message) => message.content),
      ['a question', 'an answer', 'a live reply'],
    );

    await act(async () => {
      await view.result.current.refreshLatestFromServer('viewed-session');
    });

    assert.equal(view.result.current.getMessages('viewed-session').length, 3);
  });

  it('keeps the fork-added task frames out of the transcript too', async () => {
    const { view, dispatch } = await loadedChat();

    act(() => {
      dispatch({
        kind: 'task',
        id: 'task-row-1',
        sessionId: 'viewed-session',
        provider: 'claude',
        taskId: 'task-1',
        description: 'Explore the repository',
        status: 'running',
        background: false,
        startedAt: 1767225600000,
        timestamp: '2026-01-01T00:00:07.000Z',
      } as unknown as ServerEvent);
      dispatch({
        kind: 'tool_use_summary',
        id: 'summary-row-1',
        sessionId: 'viewed-session',
        provider: 'claude',
        summary: 'Read the config',
        precedingToolUseIds: ['toolu_1'],
        timestamp: '2026-01-01T00:00:08.000Z',
      } as unknown as ServerEvent);
    });

    // Both are well-formed messages, so neither throws — but neither renders,
    // and holding them only spends the live buffer that real rows need.
    assert.deepEqual(
      view.result.current.getMessages('viewed-session').map((message) => message.content),
      ['a question', 'an answer'],
    );
  });
});

describe('a status frame whose text only says which status it is', () => {
  it('leaves the composer its own label instead of printing the discriminator', () => {
    const { activity, dispatch } = renderChat();

    act(() => {
      dispatch({ kind: 'status', text: 'activity', activity: 'compacting', sessionId: 'viewed-session' } as unknown as ServerEvent);
      dispatch({ kind: 'status', text: 'thinking_tokens', thinkingTokens: 1024, sessionId: 'viewed-session' } as unknown as ServerEvent);
    });

    assert.deepEqual(activity.map((next) => next.statusText), [null, null]);
  });

  it('still shows a status that is a sentence', () => {
    const { activity, dispatch } = renderChat();

    act(() => {
      dispatch({ kind: 'status', text: 'Reticulating splines', sessionId: 'viewed-session' } as unknown as ServerEvent);
    });

    assert.deepEqual(activity.map((next) => next.statusText), ['Reticulating splines']);
  });
});

describe('the session store itself', () => {
  it('refuses a row with no id instead of breaking the session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.appendRealtime('viewed-session', { kind: 'session_process' } as unknown as NormalizedMessage);
      result.current.appendRealtime('viewed-session', row('9', 'a real row', 'assistant'));
    });

    assert.deepEqual(
      result.current.getMessages('viewed-session').map((message) => message.content),
      ['a real row'],
    );
    assert.equal(warn.mock.calls.length, 1);
  });
});
