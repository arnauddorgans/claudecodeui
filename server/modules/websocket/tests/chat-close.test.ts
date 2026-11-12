import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { broadcastSessionProcess } from '@/modules/websocket/services/session-process-broadcast.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionProcessSnapshot } from '@/shared/types.js';

const SESSION_ID = 'process-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

const snapshot = (overrides: Partial<SessionProcessSnapshot> = {}): SessionProcessSnapshot => ({
  sessionId: SESSION_ID,
  provider: 'claude',
  state: 'chat',
  since: 1_700_000_000_000,
  providerSessionId: 'native-1',
  turnActive: false,
  tasks: [],
  ...overrides,
});

/**
 * A gateway over a runtime that keeps one process for `SESSION_ID`: `close`
 * ends it and the runtime announces it gone, as the Claude runtime does under
 * `SESSION_PROCESS_CLOSE=manual`.
 */
async function withGateway(
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    other: ReturnType<typeof createFakeSocket>;
    closes: string[];
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-close-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const closes: string[] = [];
  let alive = true;
  const socket = createFakeSocket();
  const other = createFakeSocket();
  const runtime = {
    hasRuntime: () => true,
    close: async (_provider: string, sessionId: string) => {
      closes.push(sessionId);
      if (!alive) return false;
      alive = false;
      broadcastSessionProcess(snapshot({ state: 'off' }));
      return true;
    },
    getSessionProcess: (sessionId: string) => (alive && sessionId === SESSION_ID ? snapshot() : null),
    hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [],
  };

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });
    handleChatConnection(other as never, { user: { id: 1 } } as never, { runtime: runtime as never });
    await runTest({ socket, other, closes });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('chat.close ends the process of an idle session, tells every socket, and sends no complete', async () => {
  await withGateway(async ({ socket, other, closes }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.close', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(closes, [SESSION_ID]);
    for (const client of [socket, other]) {
      assert.deepEqual(client.frames.map((frame) => [frame.kind, frame.state]), [['session_process', 'off']]);
    }
  });
});

test('chat.close under a run completes the run as aborted', async () => {
  await withGateway(async ({ socket }) => {
    const run = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: 'native-1',
      connection: socket as never,
      userId: 1,
    });
    assert.ok(run);

    socket.emit('message', JSON.stringify({ type: 'chat.close', sessionId: SESSION_ID }));
    await settle();

    const complete = socket.frames.find((frame) => frame.kind === 'complete');
    assert.equal(complete?.aborted, true);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('chat.close for an unknown session is a protocol error', async () => {
  await withGateway(async ({ socket, closes }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.close', sessionId: 'nope' }));
    await settle();

    assert.deepEqual(closes, []);
    assert.equal(socket.frames[0]?.kind, 'protocol_error');
    assert.equal(socket.frames[0]?.code, 'SESSION_NOT_FOUND');
  });
});

test('chat_subscribed carries the session process', async () => {
  await withGateway(async ({ socket }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID }, { sessionId: 'idle' }] }));
    await settle();

    const [busy, idle] = socket.frames;
    assert.equal(busy.kind, 'chat_subscribed');
    assert.equal(busy.isProcessing, false);
    assert.deepEqual((busy.process as SessionProcessSnapshot).state, 'chat');
    assert.equal(idle.process, null, 'a session without a process says so');
  });
});
