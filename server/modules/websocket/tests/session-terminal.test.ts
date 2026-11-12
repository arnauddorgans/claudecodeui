import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { sessionProcessRegistry } from '@/modules/websocket/services/session-process-registry.service.js';
import { closeTerminalSession, handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Under `SESSION_PROCESS_CLOSE=manual` a session lives in its chat process or
 * in a `/shell` terminal with its CLI resumed inside, never both; several
 * sockets can watch one terminal.
 */

function createFakeSocket<T>() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: T[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  return socket;
}

function createShellSocket() {
  const socket = createFakeSocket<string>();
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createChatSocket() {
  const socket = createFakeSocket<Record<string, unknown>>();
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  return {
    killed: false,
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    emitData(data: string) { dataListener?.(data); },
    emitExit() { exitListener?.({ exitCode: 0 }); },
    write() {},
    resize() {},
    kill() { this.killed = true; },
  };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

const resumeInit = (sessionId: string) => JSON.stringify({
  type: 'init', projectPath: process.cwd(), sessionId, hasSession: true, provider: 'claude',
});

test.afterEach(() => {
  delete process.env.SESSION_PROCESS_CLOSE;
  sessionProcessRegistry.clearAll();
});

test('a terminal resuming a session registers it, and every attached socket gets the output', async () => {
  const pty = createFakePty();
  const dependencies = { resolveProviderSessionId: () => 'provider-sid', spawnPty: () => pty as never };
  const sessionId = `term-${Date.now()}`;

  const mac = createShellSocket();
  handleShellConnection(mac as never, dependencies);
  mac.emit('message', resumeInit(sessionId));
  await settle();
  assert.equal(sessionProcessRegistry.get(sessionId, () => null)?.state, 'terminal');

  const phone = createShellSocket();
  handleShellConnection(phone as never, dependencies);
  phone.emit('message', resumeInit(sessionId));
  await settle();
  mac.frames.length = 0;
  phone.frames.length = 0;

  pty.emitData('shared-output');
  assert.equal(mac.frames.length, 1, 'the first socket keeps the stream');
  assert.equal(phone.frames.length, 1, 'the second gets it too');

  phone.emit('close');
  pty.emitData('after-phone-left');
  assert.equal(mac.frames.length, 2);
  assert.equal(pty.killed, false, 'a watcher remains');

  pty.emitExit();
  assert.equal(sessionProcessRegistry.get(sessionId, () => null), null, 'gone with the shell');
});

test('closeTerminalSession kills the PTY and clears the registry', async () => {
  const pty = createFakePty();
  const dependencies = { resolveProviderSessionId: () => 'provider-sid', spawnPty: () => pty as never };
  const sessionId = `term-close-${Date.now()}`;
  const socket = createShellSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', resumeInit(sessionId));
  await settle();

  assert.equal(closeTerminalSession(sessionId), true);
  assert.equal(pty.killed, true);
  assert.equal(sessionProcessRegistry.isInTerminal(sessionId), false);
  assert.match(socket.frames[socket.frames.length - 1], /Terminal closed/);
  assert.equal(closeTerminalSession(sessionId), false, 'nothing left to close');
});

test('a plain shell is not a session process', async () => {
  const pty = createFakePty();
  const dependencies = { resolveProviderSessionId: () => null, spawnPty: () => pty as never };
  const sessionId = `plain-${Date.now()}`;
  const socket = createShellSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init', projectPath: process.cwd(), sessionId, hasSession: false, provider: 'plain-shell', isPlainShell: true, initialCommand: 'ls',
  }));
  await settle();
  assert.equal(sessionProcessRegistry.isInTerminal(sessionId), false);
  pty.emitExit();
});

test('under manual closing, resuming a session in a terminal closes its chat process first, and the PTY outlives its last socket', async () => {
  process.env.SESSION_PROCESS_CLOSE = 'manual';
  const pty = createFakePty();
  const closed: string[] = [];
  const dependencies = {
    resolveProviderSessionId: () => 'provider-sid',
    closeChatProcess: async (_provider: string, sessionId: string) => { closed.push(sessionId); return true; },
    spawnPty: () => pty as never,
  };
  const sessionId = `takeover-${Date.now()}`;
  const socket = createShellSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', resumeInit(sessionId));
  await settle();

  assert.deepEqual(closed, [sessionId]);
  socket.emit('close');
  await settle();
  assert.equal(pty.killed, false, 'no idle kill under manual');
  assert.equal(sessionProcessRegistry.isInTerminal(sessionId), true);
  closeTerminalSession(sessionId);
});

/** A chat gateway over one session, its runtime knowing a chat process for it. */
async function withGateway(
  runTest: (context: { socket: ReturnType<typeof createChatSocket>; sessionId: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-terminal-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const sessionId = 'terminal-session';
  const socket = createChatSocket();
  const runtime = {
    hasRuntime: () => true,
    run: async () => { throw new Error('no run expected'); },
    close: async () => false,
    getSessionProcess: () => ({
      sessionId, provider: 'claude', state: 'chat', since: 1, providerSessionId: null, turnActive: false, tasks: [],
    }),
    hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [],
  };
  try {
    sessionsDb.createAppSession(sessionId, 'claude', tempDirectory);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });
    await runTest({ socket, sessionId });
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

test('under manual closing, chat.send is refused while the session lives in a terminal', async () => {
  process.env.SESSION_PROCESS_CLOSE = 'manual';
  await withGateway(async ({ socket, sessionId }) => {
    sessionProcessRegistry.terminalOpened(sessionId, 'claude');
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId, content: 'hello' }));
    await settle();

    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error' && frame.code === 'SESSION_IN_TERMINAL'), true);
    assert.equal(chatRunRegistry.isProcessing(sessionId), false);
  });
});

test('chat_subscribed reports the terminal over the chat process', async () => {
  await withGateway(async ({ socket, sessionId }) => {
    sessionProcessRegistry.terminalOpened(sessionId, 'claude');
    socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId }] }));
    await settle();

    const ack = socket.frames.find((frame) => frame.kind === 'chat_subscribed');
    assert.equal((ack?.process as { state?: string })?.state, 'terminal');
  });
});

test('opening and closing a terminal is broadcast to every chat client', async () => {
  await withGateway(async ({ socket, sessionId }) => {
    sessionProcessRegistry.terminalOpened(sessionId, 'claude');
    sessionProcessRegistry.terminalClosed(sessionId);
    await settle();

    const states = socket.frames.filter((frame) => frame.kind === 'session_process').map((frame) => frame.state);
    assert.deepEqual(states, ['terminal', 'off']);
  });
});
