import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { sessionProcessRegistry } from '@/modules/websocket/services/session-process-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionProcessSnapshot } from '@/shared/types.js';

const SESSION_ID = 'stop-task-session';

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

async function withGateway(
  process: SessionProcessSnapshot | null,
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; stopped: string[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = globalThis.process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-stop-task-'));

  closeConnection();
  globalThis.process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const stopped: string[] = [];
  const socket = createFakeSocket();

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Stop task session', now, now, path.join(tempDirectory, 'x.jsonl'));

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async () => {},
          abort: async () => true,
          close: async () => true,
          stopTask: async (_provider: string, _sessionId: string, taskId: string) => {
            stopped.push(taskId);
            return taskId !== 'task-refused';
          },
          getSessionProcess: () => process,
          onSessionProcessChange: () => () => {},
          resolveToolApproval: () => {},
          getPendingApprovalsForSession: () => [],
        } as never,
      },
    );

    await runTest({ socket, stopped });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    sessionProcessRegistry.clearAll();
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
  tasks: [
    { taskId: 'task-running', description: 'List the files', agentType: 'Explore', background: true, status: 'running', startedAt: 1 },
    { taskId: 'task-refused', description: 'Stuck', background: true, status: 'running', startedAt: 1 },
    { taskId: 'task-done', description: 'Done already', background: false, status: 'completed', startedAt: 1, endedAt: 2 },
  ],
};

const errorCode = (socket: ReturnType<typeof createFakeSocket>) =>
  socket.frames.filter((frame) => frame.kind === 'protocol_error').map((frame) => frame.code);

test('chat.stop-task stops a running task of the session process', async () => {
  await withGateway(liveProcess, async ({ socket, stopped }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'task-running' }));
    await settle();

    assert.deepEqual(stopped, ['task-running']);
    assert.equal(socket.frames.length, 0, 'the task frames tell the story, not an ack');
  });
});

test('chat.stop-task names what it cannot stop', async () => {
  await withGateway(liveProcess, async ({ socket, stopped }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID }));
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: 'nope', taskId: 'task-running' }));
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'task-unknown' }));
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'task-done' }));
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'task-refused' }));
    await settle();

    assert.deepEqual(errorCode(socket), ['TASK_ID_REQUIRED', 'SESSION_NOT_FOUND', 'TASK_NOT_FOUND', 'TASK_ENDED', 'STOP_TASK_FAILED']);
    assert.deepEqual(stopped, ['task-refused'], 'the runtime was only asked once');
  });
});

test('chat.stop-task needs a process in the chat', async () => {
  await withGateway(null, async ({ socket, stopped }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'task-running' }));
    await settle();
    assert.deepEqual(errorCode(socket), ['NO_PROCESS']);

    // A terminal has the CLI, not the control channel: its tasks are out of reach.
    sessionProcessRegistry.terminalOpened(SESSION_ID, 'claude');
    socket.frames.length = 0;
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'task-running' }));
    await settle();
    assert.deepEqual(errorCode(socket), ['NO_PROCESS']);
    assert.deepEqual(stopped, []);
  });
});
