import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection, startSelfStartedRun } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * The gateway's half of a turn the CLI starts by itself: a run of its own,
 * numbered from 1, listed as running, heard by every socket that subscribed to
 * the session before it existed, and ended by its `complete`.
 */

const SESSION_ID = 'self-started-session';

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

async function withDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-self-started-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    await runTest();
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

test('a self-started run is delivered live to a socket that only subscribed, from seq 1, and ends with complete', async () => {
  await withDatabase(async () => {
    const socket = createFakeSocket();
    const runtime = { hasRuntime: () => true, hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [] };
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });

    // Subscribed while the session was idle: no run to attach to yet.
    socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID }] }));
    await settle();
    assert.equal(socket.frames[0]?.kind, 'chat_subscribed');
    socket.frames.length = 0;

    const writer = startSelfStartedRun(SESSION_ID, 1);
    assert.ok(writer);
    assert.deepEqual(chatRunRegistry.listRunningRuns().map((run) => run.sessionId), [SESSION_ID]);
    assert.equal(startSelfStartedRun(SESSION_ID, 1), null, 'one run at a time');

    writer.send({ kind: 'text', role: 'assistant', content: 'DONE', sessionId: 'native', provider: 'claude' });
    writer.send({ kind: 'complete', exitCode: 0, sessionId: 'native', provider: 'claude' });

    assert.deepEqual(socket.frames.map((frame) => [frame.kind, frame.seq, frame.sessionId]), [
      ['text', 1, SESSION_ID],
      ['complete', 2, SESSION_ID],
    ]);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('a socket that subscribes while the self-started run goes replays it and stays on it', async () => {
  await withDatabase(async () => {
    const writer = startSelfStartedRun(SESSION_ID, null);
    assert.ok(writer);
    writer.send({ kind: 'text', role: 'assistant', content: 'working', sessionId: 'native', provider: 'claude' });

    const late = createFakeSocket();
    const runtime = { hasRuntime: () => true, hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [] };
    handleChatConnection(late as never, { user: { id: 1 } } as never, { runtime: runtime as never });
    late.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();
    writer.send({ kind: 'complete', exitCode: 0, sessionId: 'native', provider: 'claude' });

    assert.deepEqual(late.frames.map((frame) => frame.kind), ['chat_subscribed', 'text', 'complete']);
    assert.equal(late.frames[0].isProcessing, true);
  });
});

test('an unknown session opens no run', async () => {
  await withDatabase(async () => {
    assert.equal(startSelfStartedRun('nope', null), null);
  });
});
