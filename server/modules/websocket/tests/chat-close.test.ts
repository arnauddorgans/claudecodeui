import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionProcessSnapshot } from '@/shared/types.js';

const SESSION_ID = 'close-session';

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

type Calls = { closed: string[]; aborted: string[] };

let holdRun: Promise<void> | null = null;
let releaseHeldRun: (() => void) | null = null;

async function withGateway(
  process: SessionProcessSnapshot | null,
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; calls: Calls }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = globalThis.process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-close-'));

  closeConnection();
  globalThis.process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const calls: Calls = { closed: [], aborted: [] };
  const socket = createFakeSocket();

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Close session', now, now, path.join(tempDirectory, 'x.jsonl'));

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async () => {
            if (holdRun) {
              await holdRun;
            }
          },
          abort: async (_provider: string, sessionId: string) => {
            calls.aborted.push(sessionId);
            return true;
          },
          close: async (_provider: string, sessionId: string) => {
            calls.closed.push(sessionId);
            releaseHeldRun?.();
            return true;
          },
          getSessionProcess: () => process,
          onSessionProcessChange: () => () => {},
          resolveToolApproval: () => {},
          getPendingApprovalsForSession: () => [],
        } as never,
      },
    );

    await runTest({ socket, calls });
  } finally {
    releaseHeldRun?.();
    releaseHeldRun = null;
    holdRun = null;
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete globalThis.process.env.DATABASE_PATH;
    } else {
      globalThis.process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

const liveProcess: SessionProcessSnapshot = {
  sessionId: SESSION_ID,
  provider: 'claude',
  state: 'chat',
  since: 1,
  providerSessionId: 'sid',
  turnActive: false,
};

test('chat.close ends the process of an idle session and sends no complete', async () => {
  await withGateway(liveProcess, async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.close', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(calls.closed, [SESSION_ID]);
    assert.deepEqual(calls.aborted, []);
    assert.equal(socket.frames.length, 0);
  });
});

test('chat.close under a run completes the run as aborted', async () => {
  holdRun = new Promise<void>((resolve) => { releaseHeldRun = resolve; });
  await withGateway(liveProcess, async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'go' }));
    await settle();
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);

    socket.emit('message', JSON.stringify({ type: 'chat.close', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(calls.closed, [SESSION_ID]);
    const complete = socket.frames.find((frame) => frame.kind === 'complete');
    assert.ok(complete, 'a terminal complete was sent');
    assert.equal(complete.aborted, true);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('chat.close for an unknown session is a protocol error', async () => {
  await withGateway(null, async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.close', sessionId: 'nope' }));
    await settle();

    assert.deepEqual(calls.closed, []);
    assert.equal(socket.frames[0]?.kind, 'protocol_error');
    assert.equal(socket.frames[0]?.code, 'SESSION_NOT_FOUND');
  });
});

test('chat_subscribed carries the session process', async () => {
  await withGateway(liveProcess, async ({ socket }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID }] }));
    await settle();

    const ack = socket.frames.find((frame) => frame.kind === 'chat_subscribed');
    assert.ok(ack);
    assert.deepEqual(ack.process, liveProcess);
    assert.equal(ack.isProcessing, false);
  });
});
