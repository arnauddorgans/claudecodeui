import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
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
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit() {
      exitListener?.({ exitCode: 0 });
    },
    write() {},
    resize() {},
    kill() {
      this.killed = true;
    },
  };
}

test('a stale socket close cannot detach the socket that replaced it', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `stale-close-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });

  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', initMessage);

  const replacementSocket = createFakeSocket();
  handleShellConnection(replacementSocket as never, dependencies);
  replacementSocket.emit('message', initMessage);
  replacementSocket.frames.length = 0;

  // This ordering reproduces a delayed close from a backgrounded mobile tab.
  firstSocket.emit('close');
  pty.emitData('output-after-stale-close');

  assert.equal(pty.killed, false);
  assert.equal(replacementSocket.frames.length, 1);
  assert.match(replacementSocket.frames[0], /output-after-stale-close/);

  pty.emitExit();
});

test('shell output detects and normalizes a wrapped authentication URL', () => {
  const pty = createFakePty();
  const socket = createFakeSocket();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `wrapped-url-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'test-command',
    })
  );
  socket.frames.length = 0;

  pty.emitData("Continue in your browser: https://example.com/authorize?\ncode=abc\x1b[0m");

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const authenticationFrame = frames.find((frame) => frame.type === 'auth_url');
  assert.deepEqual(authenticationFrame, {
    type: 'auth_url',
    url: 'https://example.com/authorize?code=abc',
    autoOpen: false,
  });

  pty.emitExit();
});

test('bypassPermissions launches claude with --dangerously-skip-permissions', () => {
  const spawnedCommands: string[] = [];
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: (_shell: string, args: string | string[]) => {
      spawnedCommands.push(Array.isArray(args) ? args[args.length - 1] : args);
      return createFakePty() as never;
    },
  };

  const bypassSocket = createFakeSocket();
  handleShellConnection(bypassSocket as never, dependencies);
  bypassSocket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-on-${Date.now()}`,
      hasSession: false,
      provider: 'claude',
      bypassPermissions: true,
    })
  );

  const defaultSocket = createFakeSocket();
  handleShellConnection(defaultSocket as never, dependencies);
  defaultSocket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-off-${Date.now()}`,
      hasSession: false,
      provider: 'claude',
    })
  );

  assert.deepEqual(spawnedCommands, ['claude --dangerously-skip-permissions', 'claude']);
});

test('bypassPermissions carries through to resumed claude sessions', () => {
  const spawnedCommands: string[] = [];
  const dependencies = {
    resolveProviderSessionId: () => 'resumed-session-id',
    spawnPty: (_shell: string, args: string | string[]) => {
      spawnedCommands.push(Array.isArray(args) ? args[args.length - 1] : args);
      return createFakePty() as never;
    },
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-resume-${Date.now()}`,
      hasSession: true,
      provider: 'claude',
      bypassPermissions: true,
    })
  );

  assert.equal(spawnedCommands.length, 1);
  if (os.platform() !== 'win32') {
    assert.equal(
      spawnedCommands[0],
      'claude --resume "resumed-session-id" --dangerously-skip-permissions || claude --dangerously-skip-permissions'
    );
  }
});

test('a missing project directory is reported as an error frame and starts no pty', () => {
  const socket = createFakeSocket();
  let spawnCount = 0;
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => {
      spawnCount += 1;
      return createFakePty() as never;
    },
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      // A project row survives its directory being deleted or unmounted, so
      // this is what the Shell tab sends for a stale sidebar entry.
      projectPath: path.join(os.tmpdir(), `shell-missing-${Date.now()}`),
      sessionId: `missing-path-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
    })
  );

  assert.equal(spawnCount, 0);
  assert.deepEqual(
    socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>),
    [{ type: 'error', message: 'Invalid project path' }]
  );
});

// --- Where a session lives: the terminal in the registry, output to every client.

import { sessionProcessRegistry } from '@/modules/websocket/services/session-process-registry.service.js';
import { closeTerminalSession } from '@/modules/websocket/services/shell-websocket.service.js';

test('a terminal resuming a session registers it, and every attached socket gets the output', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => 'provider-sid',
    spawnPty: () => pty as never,
  };
  const sessionId = `term-${Date.now()}`;
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: true,
    provider: 'claude',
  });

  const mac = createFakeSocket();
  handleShellConnection(mac as never, dependencies);
  mac.emit('message', initMessage);
  assert.equal(sessionProcessRegistry.get(sessionId, () => null)?.state, 'terminal');

  const phone = createFakeSocket();
  handleShellConnection(phone as never, dependencies);
  phone.emit('message', initMessage);
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

test('closeTerminalSession kills the PTY and clears the registry', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => 'provider-sid',
    spawnPty: () => pty as never,
  };
  const sessionId = `term-close-${Date.now()}`;
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init', projectPath: process.cwd(), sessionId, hasSession: true, provider: 'claude',
  }));

  assert.equal(closeTerminalSession(sessionId), true);
  assert.equal(pty.killed, true);
  assert.equal(sessionProcessRegistry.isInTerminal(sessionId), false);
  assert.match(socket.frames[socket.frames.length - 1], /Terminal closed/);
  assert.equal(closeTerminalSession(sessionId), false, 'nothing left to close');
});

test('a plain shell is not a session process', () => {
  const pty = createFakePty();
  const dependencies = { resolveProviderSessionId: () => null, spawnPty: () => pty as never };
  const sessionId = `plain-${Date.now()}`;
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init', projectPath: process.cwd(), sessionId, hasSession: false, provider: 'plain-shell', isPlainShell: true, initialCommand: 'ls',
  }));
  assert.equal(sessionProcessRegistry.isInTerminal(sessionId), false);
  pty.emitExit();
});

test('under manual closing, resuming a session in a terminal closes its chat process first', async () => {
  process.env.SESSION_PROCESS_CLOSE = 'manual';
  try {
    const pty = createFakePty();
    const closed: string[] = [];
    const dependencies = {
      resolveProviderSessionId: () => 'provider-sid',
      closeChatProcess: async (_provider: string, sessionId: string) => { closed.push(sessionId); return true; },
      spawnPty: () => pty as never,
    };
    const sessionId = `takeover-${Date.now()}`;
    const socket = createFakeSocket();
    handleShellConnection(socket as never, dependencies);
    socket.emit('message', JSON.stringify({
      type: 'init', projectPath: process.cwd(), sessionId, hasSession: true, provider: 'claude',
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(closed, [sessionId]);
    pty.emitExit();
  } finally {
    delete process.env.SESSION_PROCESS_CLOSE;
  }
});
