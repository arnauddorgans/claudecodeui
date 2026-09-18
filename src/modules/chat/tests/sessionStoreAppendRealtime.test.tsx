import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * The CLI's own note about an image it resized streams live as an ordinary
 * user-role `text` message, flagged `generated` by the backend rather than
 * shaped any differently. `appendRealtime` is the single entry point every
 * websocket event goes through (see the file header), so dropping it there
 * keeps it out of both the rendered transcript and the turn-ordinal counting
 * the reconciliation helpers do over `realtimeMessages`.
 */

const note = (id: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp: '2026-07-28T20:30:21.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('appendRealtime drops a message the backend flagged generated', () => {
  const { result } = renderHook(() => useSessionStore());

  act(() => {
    result.current.appendRealtime('session-1', note('user-prompt', {
      content: 'What is in this screenshot?',
    }));
    result.current.appendRealtime('session-1', note('image-note', {
      generated: true,
      content: '[Image: original 1200x3000, displayed at 800x2000. Multiply coordinates by 1.50 to map to original image.]',
    }));
  });

  const messages = result.current.getMessages('session-1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, 'user-prompt');
});

test('appendRealtime keeps an ordinary user message with no generated flag', () => {
  const { result } = renderHook(() => useSessionStore());

  act(() => {
    result.current.appendRealtime('session-1', note('user-prompt', {
      content: 'Please look at this file',
    }));
  });

  const messages = result.current.getMessages('session-1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.generated, undefined);
});
