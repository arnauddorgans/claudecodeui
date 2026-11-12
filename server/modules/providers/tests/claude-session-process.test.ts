import assert from 'node:assert/strict';
import { mkdtemp, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  abortClaudeSDKSession,
  closeClaudeSDKSession,
  getSessionCommands,
  getSessionProcess,
  listClaudeSDKBackgroundWork,
  onSessionProcessChange,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import type { AnyRecord, ProviderRuntimeContext, SessionProcessSnapshot } from '@/shared/types.js';

/**
 * `SESSION_PROCESS_CLOSE=manual`: one process per session, kept across turns.
 * Driven through the runtime's `context.createQuery` seam with a fake that
 * reads the prompt stream the way the CLI reads its stdin and exits when it
 * ends.
 */

/** A pushable async iterable, the shape of the SDK's own output stream. */
function createChannel<T>() {
  const queue: T[] = [];
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const stream = (async function* () {
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift() as T;
      }
      if (failure) {
        throw failure;
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
    /** Ends the stream by throwing, as the SDK does on an error result. */
    fail(error: Error) { failure = error; wake?.(); },
  };
}

class FakeQuery {
  consumed: AnyRecord[] = [];
  interrupts = 0;
  stoppedTasks: string[] = [];
  models: string[] = [];
  modes: string[] = [];
  flagSettings: AnyRecord[] = [];
  exited = false;
  onInput: ((message: AnyRecord) => void) | null = null;
  readonly options: AnyRecord;
  readonly output = createChannel<AnyRecord>();
  /** Set: the stream throws this when stdin ends, instead of ending cleanly. */
  failOnExit: Error | null = null;
  /** The `initialize` answer's commands, then the latest `commands_changed` push, as the SDK keeps them. */
  commands: AnyRecord[] = [];

  constructor(prompt: AsyncIterable<unknown>, options: AnyRecord) {
    this.options = options;
    void this.consume(prompt);
  }

  private async consume(prompt: AsyncIterable<unknown>): Promise<void> {
    for await (const message of prompt) {
      this.consumed.push(message as AnyRecord);
      this.onInput?.(message as AnyRecord);
    }
    this.exited = true;
    if (this.failOnExit) {
      this.output.fail(this.failOnExit);
    } else {
      this.output.end();
    }
  }

  emit(message: AnyRecord): void {
    if (message.type === 'system' && message.subtype === 'commands_changed') {
      this.commands = message.commands;
    }
    this.output.push(message);
  }

  async supportedCommands(): Promise<AnyRecord[]> { return this.commands; }

  /** A turn as the CLI answers it: init, one assistant message, the result. */
  answer(sessionId: string): void {
    this.emit({ type: 'system', subtype: 'init', session_id: sessionId });
    this.emit({
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    this.emit({ type: 'result', subtype: 'success', session_id: sessionId });
  }

  async interrupt(): Promise<void> { this.interrupts += 1; }
  async stopTask(taskId: string): Promise<void> { this.stoppedTasks.push(taskId); }
  async setModel(model: string): Promise<void> { this.models.push(model); }
  async setPermissionMode(mode: string): Promise<void> { this.modes.push(mode); }
  async applyFlagSettings(settings: AnyRecord): Promise<void> { this.flagSettings.push(settings); }

  [Symbol.asyncIterator]() {
    return this.output.stream[Symbol.asyncIterator]();
  }
}

function createWriter() {
  const frames: AnyRecord[] = [];
  const ids: string[] = [];
  return {
    frames,
    ids,
    userId: null,
    isWebSocketWriter: true,
    send(data: unknown) { frames.push(data as AnyRecord); },
    setSessionId(id: string) { ids.push(id); },
  };
}

/** A fake SDK answering every prompt at once, and the queries it created. */
function createContext(
  script: (query: FakeQuery) => void = (query) => { query.onInput = () => query.answer('sid-1'); },
  overrides: Partial<ProviderRuntimeContext> = {},
) {
  const queries: FakeQuery[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId, requested) => requested ?? undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
    normalizeMessage: (raw, sessionId) => {
      const message = raw as AnyRecord;
      if (message.type !== 'assistant') {
        return [];
      }
      return [{ id: 'm', kind: 'text', role: 'assistant', content: 'hi', sessionId: sessionId ?? '', provider: 'claude', timestamp: '' }];
    },
    isProviderInstalled: async () => true,
    createQuery: ({ prompt, options }) => {
      const query = new FakeQuery(prompt, options);
      script(query);
      queries.push(query);
      return query as never;
    },
    ...overrides,
  };
  return { context, queries };
}

const tick = (ms = 10) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await tick(5);
  }
  assert.ok(condition(), 'condition never became true');
}

test.before(async () => {
  // The runtime reads the user MCP config; keep it off the real one.
  process.env.CLAUDE_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), 'claude-session-process-'));
});

test.beforeEach(() => {
  process.env.SESSION_PROCESS_CLOSE = 'manual';
});

test.afterEach(() => {
  delete process.env.SESSION_PROCESS_CLOSE;
});

test('two turns of a session go through one process, which lives on until closed', async () => {
  const { context, queries } = createContext();
  const writer = createWriter();
  const changes: SessionProcessSnapshot[] = [];
  const unsubscribe = onSessionProcessChange((snapshot) => changes.push(snapshot));

  await queryClaudeSDK('hello', { sessionId: 'app-1' }, writer as never, context);
  await queryClaudeSDK('again', { sessionId: 'app-1' }, writer as never, context);

  assert.equal(queries.length, 1, 'one process for both turns');
  assert.equal(queries[0].consumed.length, 2, 'both prompts went to its stdin');
  assert.equal(queries[0].options.resume, undefined, 'a new session is not resumed');
  assert.equal(writer.frames.filter((frame) => frame.kind === 'complete').length, 2);
  assert.equal(writer.frames.filter((frame) => frame.kind === 'session_created').length, 1);
  assert.equal(getSessionProcess('app-1')?.state, 'chat');
  assert.equal(getSessionProcess('app-1')?.turnActive, false);
  assert.equal(getSessionProcess('app-1')?.providerSessionId, 'sid-1');
  assert.equal(queries[0].exited, false, 'the process stays after the turn');

  assert.equal(await closeClaudeSDKSession('app-1'), true);
  assert.equal(queries[0].exited, true, 'close ends its stdin');
  assert.equal(getSessionProcess('app-1'), null);
  assert.equal(changes.at(-1)?.state, 'off');
  assert.ok(changes.some((change) => change.state === 'chat' && change.turnActive), 'a turn is announced open');
  unsubscribe();
});

test('a resumed session starts its process with the provider id', async () => {
  const { context, queries } = createContext(
    (query) => { query.onInput = () => query.answer('sid-9'); },
    { resolveProviderSessionId: () => 'sid-9' },
  );
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: 'app-9' }, writer as never, context);

  assert.equal(queries[0].options.resume, 'sid-9');
  assert.equal(writer.frames.some((frame) => frame.kind === 'session_created'), false);
  await closeClaudeSDKSession('app-9');
});

test('abort interrupts the turn and keeps the process', async () => {
  const { context, queries } = createContext((query) => { query.onInput = () => {}; });
  const writer = createWriter();

  const turn = queryClaudeSDK('hello', { sessionId: 'app-2' }, writer as never, context);
  await until(() => Boolean(getSessionProcess('app-2')));
  assert.equal(await abortClaudeSDKSession('app-2'), true, 'abort returns once the CLI took the interrupt');
  assert.equal(queries[0].interrupts, 1);
  let turnSettled = false;
  void turn.then(() => { turnSettled = true; });
  await tick();
  assert.equal(turnSettled, false, 'the turn stays open until its own result');
  queries[0].emit({ type: 'result', subtype: 'error_during_execution', session_id: 'sid-2' });
  await turn;

  assert.equal(writer.frames.some((frame) => frame.kind === 'complete'), false, 'the abort handler sends the complete');
  assert.equal(queries[0].exited, false);
  assert.equal(getSessionProcess('app-2')?.state, 'chat');

  // The next turn goes to the same process, and ends with a complete of its own.
  queries[0].onInput = () => queries[0].answer('sid-2');
  await queryClaudeSDK('next', { sessionId: 'app-2' }, writer as never, context);
  assert.equal(queries.length, 1);
  assert.equal(writer.frames.filter((frame) => frame.kind === 'complete').length, 1);
  await closeClaudeSDKSession('app-2');
});

test('closing after an abort stays silent when the CLI ends the interrupted turn with an error', async () => {
  const { context, queries } = createContext((query) => { query.onInput = () => {}; });
  const writer = createWriter();

  const turn = queryClaudeSDK('hello', { sessionId: 'app-2b' }, writer as never, context);
  await until(() => Boolean(getSessionProcess('app-2b')));
  assert.equal(await abortClaudeSDKSession('app-2b'), true);
  queries[0].emit({ type: 'result', subtype: 'error_during_execution', session_id: 'sid-2b' });
  await turn;

  // What the SDK does once stdin closes on an interrupted turn.
  queries[0].failOnExit = new Error('Claude Code returned an error result: [ede_diagnostic] result_type=user');
  assert.equal(await closeClaudeSDKSession('app-2b'), true);
  await until(() => getSessionProcess('app-2b') === null);
  await tick();

  assert.deepEqual(writer.frames.filter((frame) => frame.kind === 'error'), [], 'no error frame for the interrupted turn');
  assert.equal(writer.frames.some((frame) => frame.kind === 'complete'), false, 'the abort handler sent the only complete');
});

test('a live turn whose stream throws still reports the error', async () => {
  const { context, queries } = createContext((query) => {
    query.onInput = () => { query.emit({ type: 'system', subtype: 'init', session_id: 'sid-2c' }); };
  });
  const writer = createWriter();

  const turn = queryClaudeSDK('hello', { sessionId: 'app-2c' }, writer as never, context);
  await until(() => Boolean(getSessionProcess('app-2c')));
  await tick();
  queries[0].output.fail(new Error('boom'));
  await turn;

  assert.equal(writer.frames.filter((frame) => frame.kind === 'error').length, 1, 'the failure reaches the client');
  assert.ok(writer.frames.find((frame) => frame.kind === 'complete'), 'and a terminal complete follows');
});

test('editing a sent message replaces the process', async () => {
  const { context, queries } = createContext(undefined, { resolveProviderSessionId: () => 'sid-3' });
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: 'app-3' }, writer as never, context);
  await queryClaudeSDK('edited', { sessionId: 'app-3', resumeAnchorId: 'row-7' }, writer as never, context);

  assert.equal(queries.length, 2);
  assert.equal(queries[0].exited, true, 'the first process was closed');
  assert.equal(queries[1].options.resumeSessionAt, 'row-7');
  assert.equal(getSessionProcess('app-3')?.state, 'chat');
  await closeClaudeSDKSession('app-3');
});

test('another working directory replaces the process', async () => {
  const { context, queries } = createContext();
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: 'app-3b', cwd: os.tmpdir() }, writer as never, context);
  await queryClaudeSDK('elsewhere', { sessionId: 'app-3b', cwd: path.join(os.tmpdir(), 'x') }, writer as never, context);

  assert.equal(queries.length, 2);
  assert.equal(queries[0].exited, true);
  await closeClaudeSDKSession('app-3b');
});

test('the same directory by another path keeps the process (the row reads the cwd back resolved)', async () => {
  const { context, queries } = createContext();
  const writer = createWriter();
  const real = await mkdtemp(path.join(os.tmpdir(), 'claude-session-cwd-'));
  const link = `${real}-link`;
  await symlink(real, link);

  // The first turn runs in the path the session was created with; the CLI
  // writes its resolved cwd to the transcript, which the row then carries.
  await queryClaudeSDK('hello', { sessionId: 'app-3c', cwd: link }, writer as never, context);
  await queryClaudeSDK('again', { sessionId: 'app-3c', cwd: await realpath(link) }, writer as never, context);

  assert.equal(queries.length, 1, 'one process for both turns');
  assert.equal(queries[0].exited, false);
  assert.equal(queries[0].consumed.length, 2);
  assert.equal(getSessionProcess('app-3c')?.state, 'chat');
  await closeClaudeSDKSession('app-3c');
});

test('model, permission mode and effort change on the live process', async () => {
  const { context, queries } = createContext();
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: 'app-4', model: 'sonnet' }, writer as never, context);
  await queryClaudeSDK('again', { sessionId: 'app-4', model: 'sonnet', permissionMode: 'plan', effort: 'high' }, writer as never, context);
  await queryClaudeSDK('third', { sessionId: 'app-4', model: 'sonnet', permissionMode: 'plan', effort: 'high' }, writer as never, context);
  await queryClaudeSDK('fourth', { sessionId: 'app-4', model: 'opus', permissionMode: 'plan', effort: 'high' }, writer as never, context);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].models, ['opus']);
  assert.deepEqual(queries[0].modes, ['plan']);
  assert.deepEqual(queries[0].flagSettings, [{ effortLevel: 'high', ultracode: null, enableWorkflows: null }], 'applied once, not on the unchanged turn');
  await closeClaudeSDKSession('app-4');
});

test('an unattended caller (agent API) gets a process for one turn', async () => {
  const { context, queries } = createContext((query) => { query.onInput = () => query.answer('sid-5'); });
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: 'app-5', unattended: true }, writer as never, context);
  await until(() => queries[0].exited);

  assert.equal(getSessionProcess('app-5'), null, 'not a session process');
});

test('a process that dies under a turn reports the error and completes', async () => {
  const { context, queries } = createContext((query) => {
    query.onInput = () => {
      query.emit({ type: 'system', subtype: 'init', session_id: 'sid-6' });
      query.emit({ type: 'assistant', session_id: 'sid-6', message: { role: 'assistant', content: [] } });
    };
  });
  const writer = createWriter();

  const turn = queryClaudeSDK('hello', { sessionId: 'app-6' }, writer as never, context);
  await until(() => Boolean(getSessionProcess('app-6')));
  await tick();
  queries[0].output.end();
  await turn;

  assert.ok(writer.frames.find((frame) => frame.kind === 'complete'), 'the client still gets a terminal complete');
  assert.equal(getSessionProcess('app-6'), null);
});

test('auto: every turn gets its own process, and none is announced', async () => {
  process.env.SESSION_PROCESS_CLOSE = 'auto';
  const { context, queries } = createContext();
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: 'app-7' }, writer as never, context);
  await until(() => queries[0].exited);
  assert.equal(getSessionProcess('app-7'), null);

  await queryClaudeSDK('again', { sessionId: 'app-7' }, writer as never, context);
  assert.equal(queries.length, 2);
  assert.equal(queries[1].consumed.length, 1);
});

test('background work survives the next turn, and its tasks stay on the record after they end', async () => {
  const sid = 'sid-10';
  const { context, queries } = createContext((query) => {
    let turn = 0;
    query.onInput = () => {
      turn += 1;
      query.emit({ type: 'system', subtype: 'init', session_id: sid });
      if (turn === 1) {
        query.emit({
          type: 'assistant',
          session_id: sid,
          parent_tool_use_id: null,
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'sleep 20', run_in_background: true } }] },
        });
        query.emit({ type: 'system', subtype: 'task_started', session_id: sid, task_id: 'task-1', tool_use_id: 'tu-1', task_type: 'local_bash', description: 'sleep 20' });
      }
      query.emit({ type: 'result', subtype: 'success', session_id: sid });
    };
  });
  const writer = createWriter();
  const changes: SessionProcessSnapshot[] = [];
  const unsubscribe = onSessionProcessChange((snapshot) => changes.push(snapshot));

  await queryClaudeSDK('start it', { sessionId: 'app-10' }, writer as never, context);
  await queryClaudeSDK('and now?', { sessionId: 'app-10' }, writer as never, context);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].stoppedTasks, [], 'the next turn stops nothing');
  assert.deepEqual(
    listClaudeSDKBackgroundWork().find((entry) => entry.sessionId === 'app-10')?.tasks.map((task) => task.taskId),
    ['task-1'],
  );
  const started = getSessionProcess('app-10')?.tasks[0];
  assert.equal(started?.taskId, 'task-1');
  assert.equal(started?.status, 'started');
  assert.equal(started?.background, true);
  assert.equal(started?.toolUseId, 'tu-1');

  // Stopped on request: the CLI answers with the task's notification.
  queries[0].stopTask = async (taskId: string) => {
    queries[0].stoppedTasks.push(taskId);
    queries[0].emit({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: taskId, tool_use_id: 'tu-1', status: 'stopped', summary: 'stopped' });
  };
  assert.equal(await stopClaudeSDKTask('app-10', 'task-1'), true);
  const ended = getSessionProcess('app-10')?.tasks[0];
  assert.equal(ended?.status, 'stopped');
  assert.equal(typeof ended?.endedAt, 'number');
  assert.equal(queries[0].exited, false, 'the last task stopping does not release the process');
  assert.ok(changes.some((change) => change.tasks.some((task) => task.status === 'stopped')), 'the end is announced');

  unsubscribe();
  await closeClaudeSDKSession('app-10');
});

test('close stops the tasks still running before it lets the process go', async () => {
  const sid = 'sid-11';
  const { context, queries } = createContext((query) => {
    query.onInput = () => {
      query.emit({ type: 'system', subtype: 'init', session_id: sid });
      query.emit({ type: 'system', subtype: 'task_started', session_id: sid, task_id: 'task-2', tool_use_id: 'tu-2', task_type: 'local_agent', description: 'agent' });
      query.emit({ type: 'result', subtype: 'success', session_id: sid });
    };
  });
  const writer = createWriter();

  await queryClaudeSDK('go', { sessionId: 'app-11' }, writer as never, context);
  assert.equal(await closeClaudeSDKSession('app-11'), true);
  assert.deepEqual(queries[0].stoppedTasks, ['task-2']);
  assert.equal(queries[0].exited, true);
  assert.equal(await closeClaudeSDKSession('app-11'), false, 'nothing left to close');
});

test('close under a turn interrupts it and leaves the complete to the caller', async () => {
  const { context, queries } = createContext((query) => { query.onInput = () => {}; });
  const writer = createWriter();

  const turn = queryClaudeSDK('long', { sessionId: 'app-12' }, writer as never, context);
  await until(() => Boolean(getSessionProcess('app-12')));
  await closeClaudeSDKSession('app-12');
  await turn;

  assert.equal(queries[0].interrupts, 1);
  assert.equal(writer.frames.some((frame) => frame.kind === 'complete'), false);
  assert.equal(getSessionProcess('app-12'), null);
});

test('the turn\'s activity rides on the process record while it runs, and is gone after', async () => {
  const sid = 'sid-13';
  const { context, queries } = createContext((query) => { query.onInput = () => {}; });
  const writer = createWriter();

  const turn = queryClaudeSDK('think', { sessionId: 'app-13' }, writer as never, context);
  await until(() => Boolean(getSessionProcess('app-13')));
  queries[0].emit({ type: 'system', subtype: 'init', session_id: sid });
  queries[0].emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: sid });
  queries[0].emit({ type: 'tool_use_summary', summary: 'Read two files', preceding_tool_use_ids: ['tu-1'], session_id: sid });
  await until(() => getSessionProcess('app-13')?.activity?.summary === 'Read two files');

  assert.equal(getSessionProcess('app-13')?.activity?.status, 'compacting');
  assert.deepEqual(writer.frames.filter((frame) => frame.text === 'activity').map((frame) => frame.activity), ['compacting']);
  assert.equal(writer.frames.filter((frame) => frame.kind === 'tool_use_summary').length, 1);

  queries[0].emit({ type: 'result', subtype: 'success', session_id: sid });
  await turn;
  assert.equal('activity' in (getSessionProcess('app-13') ?? {}), false, 'no activity key between turns');
  await closeClaudeSDKSession('app-13');
});

test('the live process lists its slash commands, and a pushed list replaces them', async () => {
  const { context, queries } = createContext((query) => {
    query.commands = [
      { name: 'clear', description: 'Clear the conversation', argumentHint: '', aliases: ['reset'], builtin: true },
      { name: 'graphify', description: 'Build a graph (user)', argumentHint: '<path>' },
    ];
    query.onInput = () => query.answer('sid-c');
  });
  const writer = createWriter();
  const changes: SessionProcessSnapshot[] = [];
  const unsubscribe = onSessionProcessChange((snapshot) => changes.push(snapshot));

  assert.equal(await getSessionCommands('app-c'), null, 'no process, no list');
  await queryClaudeSDK('hello', { sessionId: 'app-c' }, writer as never, context);

  const first = await getSessionCommands('app-c');
  assert.deepEqual(first?.commands, [
    { name: 'clear', description: 'Clear the conversation', argumentHint: '', aliases: ['reset'], builtin: true },
    { name: 'graphify', description: 'Build a graph (user)', argumentHint: '<path>', aliases: [], builtin: false },
  ]);
  assert.equal(getSessionProcess('app-c')?.commandsVersion, undefined, 'no push yet');

  // A skill found mid-session: the CLI pushes the whole list again, between turns here.
  queries[0].emit({
    type: 'system',
    subtype: 'commands_changed',
    session_id: 'sid-c',
    uuid: 'u-1',
    commands: [{ name: 'deploy', description: 'Ship it (project)', argumentHint: '' }],
  });
  await until(() => getSessionProcess('app-c')?.commandsVersion === 1);
  assert.equal(changes.at(-1)?.commandsVersion, 1, 'the change is announced');
  assert.equal(changes.at(-1)?.turnActive, false, 'and opens no turn');
  const second = await getSessionCommands('app-c');
  assert.deepEqual(second?.commands, [
    { name: 'deploy', description: 'Ship it (project)', argumentHint: '', aliases: [], builtin: false },
  ], 'replaced, not merged');
  assert.ok((second?.updatedAt ?? 0) >= (first?.updatedAt ?? Infinity));
  assert.equal(queries.length, 1, 'no process started for any of it');
  assert.equal(queries[0].consumed.length, 1, 'and no turn sent');

  unsubscribe();
  await closeClaudeSDKSession('app-c');
  assert.equal(await getSessionCommands('app-c'), null, 'a closed process lists nothing');
});
