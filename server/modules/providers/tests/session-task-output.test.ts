import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  closeClaudeSDKSession,
  queryClaudeSDK,
  setClaudeQueryImplementation,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** A pushable async iterable, the shape of the SDK's own output stream. */
function createChannel<T>() {
  const queue: T[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const stream = (async function* () {
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift() as T;
      }
      if (ended) {
        return;
      }
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = null;
    }
  })();
  return {
    stream,
    push(value: T) { queue.push(value); wake?.(); },
    end() { ended = true; wake?.(); },
  };
}

/** Stands in for the SDK's `query()`: exits when its prompt stream ends, emits whatever the test scripts. */
class FakeQuery {
  exited = false;
  onInput: ((message: AnyRecord) => void) | null = null;
  private readonly output = createChannel<AnyRecord>();

  constructor(prompt: AsyncIterable<AnyRecord>) {
    void this.consume(prompt);
  }

  private async consume(prompt: AsyncIterable<AnyRecord>): Promise<void> {
    for await (const _message of prompt) {
      this.onInput?.(_message);
    }
    this.exited = true;
    this.output.end();
  }

  emit(message: AnyRecord): void {
    this.output.push(message);
  }

  async interrupt(): Promise<void> {}
  async stopTask(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}

  [Symbol.asyncIterator]() {
    return this.output.stream[Symbol.asyncIterator]();
  }
}

const sessions = new ClaudeSessionsProvider();

function createContext(): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId, requested) => requested ?? undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
}

const writer = {
  userId: null,
  isWebSocketWriter: true,
  send() {},
  setSessionId() {},
};

const SESSION_ID = 'app-task-output';
const PROVIDER_SESSION_ID = 'sid-task-output';

type Fixture = {
  baseUrl: string;
  /** Where the announced output files live. */
  outputDirectory: string;
  /** The temp dir the CLI would write a task's output under, for the derived path. */
  tmpDirectory: string;
  workspacePath: string;
  query: FakeQuery;
  read(taskId: string, search?: string): Promise<{ status: number; body: AnyRecord }>;
};

type TaskOutputChunk = {
  taskId: string;
  status: string;
  running: boolean;
  outputFileSource: string;
  encoding: string;
  content: string;
  offset: number;
  nextOffset: number;
  bytesRead: number;
  size: number;
  truncated: boolean;
};

/**
 * One session with a live process, a fake SDK to script its task events with,
 * and the route mounted where the app mounts it. Each test starts the tasks it
 * needs on that process and reads them back over HTTP.
 */
async function withTaskProcess(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousTmpDirectory = process.env.CLAUDE_CODE_TMPDIR;
  const previousClose = process.env.SESSION_PROCESS_CLOSE;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'task-output-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  process.env.SESSION_PROCESS_CLOSE = 'manual';
  process.env.CLAUDE_CODE_TMPDIR = path.join(temporaryDirectory, 'tmp');

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const workspacePath = path.join(temporaryDirectory, 'workspace');
  const outputDirectory = path.join(temporaryDirectory, 'outputs');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });

  const queries: FakeQuery[] = [];
  setClaudeQueryImplementation((args: AnyRecord) => {
    const query = new FakeQuery(args.prompt as AsyncIterable<AnyRecord>);
    query.onInput = () => {
      query.emit({ type: 'system', subtype: 'init', session_id: PROVIDER_SESSION_ID });
      query.emit({ type: 'result', subtype: 'success', session_id: PROVIDER_SESSION_ID });
    };
    queries.push(query);
    return query;
  });

  try {
    await queryClaudeSDK(
      'start the build',
      { sessionId: SESSION_ID, cwd: workspacePath },
      writer,
      createContext(),
    );
    const address = server.address() as AddressInfo;
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      outputDirectory,
      tmpDirectory: process.env.CLAUDE_CODE_TMPDIR,
      workspacePath,
      query: queries[0],
      async read(taskId, search = '') {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/providers/sessions/${SESSION_ID}/tasks/${taskId}/output${search}`,
        );
        return { status: response.status, body: await response.json() as AnyRecord };
      },
    });
  } finally {
    await closeClaudeSDKSession(SESSION_ID);
    setClaudeQueryImplementation(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    for (const [key, value] of Object.entries({
      DATABASE_PATH: previousDatabasePath,
      CLAUDE_CODE_TMPDIR: previousTmpDirectory,
      SESSION_PROCESS_CLOSE: previousClose,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Lets the runtime's reader drain what the fake SDK just emitted. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Starts a task, and names the file it writes to the way an asynchronous agent's launch does. */
async function startAnnouncedTask(fixture: Fixture, taskId: string, outputFile: string): Promise<void> {
  fixture.query.emit({
    type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `toolu_${taskId}`,
    description: 'Run the build', task_type: 'subagent', uuid: `u-${taskId}`, session_id: PROVIDER_SESSION_ID,
  });
  fixture.query.emit({
    type: 'user',
    session_id: PROVIDER_SESSION_ID,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${taskId}`, content: 'launched' }] },
    tool_use_result: { isAsync: true, status: 'async_launched', agentId: taskId, outputFile },
  });
  await settle();
}

/** Ends a task with the notification the CLI sends, which is where it names the output file. */
async function endTask(fixture: Fixture, taskId: string, outputFile: string): Promise<void> {
  fixture.query.emit({
    type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: `toolu_${taskId}`,
    status: 'completed', output_file: outputFile, summary: 'Build finished',
    uuid: `u-${taskId}-done`, session_id: PROVIDER_SESSION_ID,
  });
  await settle();
}

test('a task\'s output comes back from offset 0, then forward from the offset it returned', async () => {
  await withTaskProcess(async (fixture) => {
    const outputFile = path.join(fixture.outputDirectory, 'agent-live.output');
    await writeFile(outputFile, 'first half\n');
    await startAnnouncedTask(fixture, 'agent-live', outputFile);

    const first = await fixture.read('agent-live');
    const opening = first.body.data as TaskOutputChunk;
    assert.equal(first.status, 200);
    assert.equal(opening.content, 'first half\n');
    assert.equal(opening.offset, 0);
    assert.equal(opening.nextOffset, 11);
    assert.equal(opening.bytesRead, 11);
    assert.equal(opening.size, 11);
    assert.equal(opening.truncated, false);
    assert.equal(opening.running, true, 'the task is still going');
    assert.equal(opening.status, 'started');
    assert.equal(opening.outputFileSource, 'announced', 'the launch of the agent named the file');
    assert.equal(opening.encoding, 'text');

    // Nothing new yet: the same offset comes back empty rather than repeating itself.
    const idle = (await fixture.read('agent-live', `?offset=${opening.nextOffset}`)).body.data as TaskOutputChunk;
    assert.equal(idle.content, '');
    assert.equal(idle.nextOffset, 11);
    assert.equal(idle.running, true);

    await appendFile(outputFile, 'second half\n');
    const next = (await fixture.read('agent-live', `?offset=${opening.nextOffset}`)).body.data as TaskOutputChunk;
    assert.equal(next.content, 'second half\n', 'only what was written since');
    assert.equal(next.offset, 11);
    assert.equal(next.nextOffset, 23);
    assert.equal(next.size, 23);

    await endTask(fixture, 'agent-live', outputFile);
    const last = (await fixture.read('agent-live', `?offset=${next.nextOffset}`)).body.data as TaskOutputChunk;
    assert.equal(last.content, '');
    assert.equal(last.running, false, 'the client stops polling here');
    assert.equal(last.status, 'completed');
  });
});

test('tail reads the end of an output, and the cap says where to carry on', async () => {
  await withTaskProcess(async (fixture) => {
    const outputFile = path.join(fixture.outputDirectory, 'task-done.output');
    // 4 KiB of numbered lines: more than the smallest window a caller can ask for.
    const lines = Array.from({ length: 256 }, (_unused, index) => `line ${String(index).padStart(3, '0')}\n`);
    await writeFile(outputFile, lines.join(''));
    const size = lines.join('').length;
    await startAnnouncedTask(fixture, 'task-done', outputFile);
    await endTask(fixture, 'task-done', outputFile);

    const tail = (await fixture.read('task-done', '?tail=27')).body.data as TaskOutputChunk;
    assert.equal(tail.content, 'line 253\nline 254\nline 255\n', 'the end of the log, not its start');
    assert.equal(tail.offset, size - 27);
    assert.equal(tail.nextOffset, size);
    assert.equal(tail.size, size);
    assert.equal(tail.running, false);

    const capped = (await fixture.read('task-done', '?limit=1024')).body.data as TaskOutputChunk;
    assert.equal(capped.bytesRead, 1024);
    assert.equal(capped.nextOffset, 1024);
    assert.equal(capped.truncated, true, 'more is already there');
    assert.equal(capped.content.slice(0, 9), 'line 000\n');
    // The cap counts bytes, not lines: it falls wherever it falls.
    assert.equal(capped.content.endsWith('line 11'), true);

    const rest = (await fixture.read('task-done', `?offset=${capped.nextOffset}&limit=1024`)).body.data as TaskOutputChunk;
    assert.equal(rest.offset, 1024);
    assert.equal(rest.content.startsWith('3\nline 114\n'), true, 'the line the cap cut, carried on');
    assert.equal(rest.truncated, true);
  });
});

test('a running task is followed before the CLI ever says where it writes', async () => {
  await withTaskProcess(async (fixture) => {
    fixture.query.emit({
      type: 'system', subtype: 'task_started', task_id: 'b7k2m1x', tool_use_id: 'toolu_bash',
      description: 'npm test', task_type: 'bash', uuid: 'u-bash', session_id: PROVIDER_SESSION_ID,
    });
    await settle();

    // Nothing announced the file: the runtime works the CLI's own path out
    // from the process (temp dir, encoded cwd, provider session id, task id).
    const derived = path.join(
      fixture.tmpDirectory,
      `claude-${process.getuid?.() ?? 0}`,
      fixture.workspacePath.replace(/[^a-zA-Z0-9]/g, '-'),
      PROVIDER_SESSION_ID,
      'tasks',
    );
    await mkdir(derived, { recursive: true });
    await writeFile(path.join(derived, 'b7k2m1x.output'), 'compiling…\n');

    const chunk = (await fixture.read('b7k2m1x')).body.data as TaskOutputChunk;
    assert.equal(chunk.content, 'compiling…\n');
    assert.equal(chunk.outputFileSource, 'derived');
    assert.equal(chunk.running, true);
    assert.equal(chunk.size, 13, 'bytes, not characters');
    assert.equal(chunk.nextOffset, 13);

    // An offset can land inside a multi-byte character — `…` is bytes 9 to 11.
    // A text answer opens on the next whole character and says where it did;
    // base64 hands back the bytes as they are.
    const whole = (await fixture.read('b7k2m1x', '?offset=9')).body.data as TaskOutputChunk;
    assert.equal(whole.content, '…\n');
    assert.equal(whole.offset, 9);

    const split = (await fixture.read('b7k2m1x', '?offset=10')).body.data as TaskOutputChunk;
    assert.equal(split.content, '\n', 'never half a character');
    assert.equal(split.offset, 12, 'the window moved past the character it landed inside');
    assert.equal(split.bytesRead, 1);

    const raw = (await fixture.read('b7k2m1x', '?offset=10&encoding=base64')).body.data as TaskOutputChunk;
    assert.equal(raw.encoding, 'base64');
    assert.equal(raw.offset, 10);
    assert.equal(Buffer.from(raw.content, 'base64').toString('hex'), '80a60a', 'the exact bytes, mid-character');
  });
});

test('a missing file, an unknown task and a session with no process are each their own error', async () => {
  await withTaskProcess(async (fixture) => {
    const missing = path.join(fixture.outputDirectory, 'never-written.output');
    await startAnnouncedTask(fixture, 'task-gone', missing);
    await endTask(fixture, 'task-gone', missing);

    const gone = await fixture.read('task-gone');
    assert.equal(gone.status, 404);
    assert.equal((gone.body.error as AnyRecord).code, 'TASK_OUTPUT_NOT_FOUND');

    const unknown = await fixture.read('task-nobody-ran');
    assert.equal(unknown.status, 404);
    assert.equal((unknown.body.error as AnyRecord).code, 'TASK_NOT_FOUND');

    const noProcess = await fetch(
      `${fixture.baseUrl}/api/providers/sessions/app-elsewhere/tasks/task-gone/output`,
    );
    assert.equal(noProcess.status, 409);
    assert.equal(((await noProcess.json() as AnyRecord).error as AnyRecord).code, 'SESSION_PROCESS_NOT_RUNNING');

    // A directory where a file should be is not a 200 with nothing in it.
    await startAnnouncedTask(fixture, 'task-folder', fixture.outputDirectory);
    const folder = await fixture.read('task-folder');
    assert.equal(folder.status, 403);
    assert.equal((folder.body.error as AnyRecord).code, 'TASK_OUTPUT_UNREADABLE');
  });
});

test('the route cannot be pointed at a file other than the task\'s own', async () => {
  await withTaskProcess(async (fixture) => {
    const outputFile = path.join(fixture.outputDirectory, 'task-secret.output');
    const secret = path.join(fixture.outputDirectory, 'passwords.txt');
    await writeFile(outputFile, 'the task said this\n');
    await writeFile(secret, 'root:hunter2\n');
    await startAnnouncedTask(fixture, 'task-secret', outputFile);

    // A path where a task id belongs never reaches the filesystem.
    for (const attempt of ['..%2f..%2fetc%2fpasswd', encodeURIComponent('../passwords.txt')]) {
      const response = await fetch(
        `${fixture.baseUrl}/api/providers/sessions/${SESSION_ID}/tasks/${attempt}/output`,
      );
      assert.equal(response.status, 400, `${attempt} is not a task id`);
      assert.equal(((await response.json() as AnyRecord).error as AnyRecord).code, 'INVALID_TASK_ID');
    }

    // A segment that walks up never even reaches the route.
    const walked = await fetch(`${fixture.baseUrl}/api/providers/sessions/${SESSION_ID}/tasks/../output`);
    assert.equal(walked.status, 404);

    // Nor does a query parameter that looks like one: the file comes from the
    // task's record, and the rest is ignored.
    const decoy = await fixture.read(
      'task-secret',
      `?path=${encodeURIComponent(secret)}&file=${encodeURIComponent(secret)}&outputFile=${encodeURIComponent(secret)}`,
    );
    assert.equal(decoy.status, 200);
    assert.equal((decoy.body.data as TaskOutputChunk).content, 'the task said this\n');
  });
});
