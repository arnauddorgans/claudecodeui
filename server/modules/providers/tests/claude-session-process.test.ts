import assert from 'node:assert/strict';
import test from 'node:test';

import {
  abortClaudeSDKSession,
  closeClaudeSDKSession,
  getSessionProcess,
  onSessionProcessChange,
  queryClaudeSDK,
  setClaudeQueryImplementation,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import type { AnyRecord, ProviderRuntimeContext, SessionProcessSnapshot } from '@/shared/types.js';

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

/**
 * Stands in for the SDK's `query()`: consumes the prompt stream like the CLI
 * reads stdin, exits when it ends, and emits whatever the test scripts.
 */
class FakeQuery {
  consumed: AnyRecord[] = [];
  interrupts = 0;
  models: string[] = [];
  modes: string[] = [];
  exited = false;
  onInput: ((message: AnyRecord) => void) | null = null;
  readonly options: AnyRecord;
  private readonly output = createChannel<AnyRecord>();

  constructor(prompt: AsyncIterable<AnyRecord>, options: AnyRecord) {
    this.options = options;
    void this.consume(prompt);
  }

  private async consume(prompt: AsyncIterable<AnyRecord>): Promise<void> {
    for await (const message of prompt) {
      this.consumed.push(message);
      this.onInput?.(message);
    }
    this.exited = true;
    this.output.end();
  }

  emit(message: AnyRecord): void {
    this.output.push(message);
  }

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
  async setModel(model: string): Promise<void> { this.models.push(model); }
  async setPermissionMode(mode: string): Promise<void> { this.modes.push(mode); }

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

function createContext(overrides: Partial<ProviderRuntimeContext> = {}): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId, requested) => requested ?? undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
    normalizeMessage: (raw, sessionId) => {
      const message = raw as AnyRecord;
      if (message.type !== 'assistant') {
        return [];
      }
      return [{
        id: 'm', kind: 'text', role: 'assistant', content: 'hi', sessionId: sessionId ?? '', provider: 'claude', timestamp: '',
      }];
    },
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

async function untilExited(query: FakeQuery): Promise<void> {
  for (let i = 0; i < 50 && !query.exited; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Installs a fake SDK that answers every prompt at once, and collects the queries it created. */
function installFakeSdk(script: (query: FakeQuery) => void = (query) => { query.onInput = () => query.answer('sid-1'); }) {
  const queries: FakeQuery[] = [];
  setClaudeQueryImplementation((args: AnyRecord) => {
    const query = new FakeQuery(args.prompt, args.options);
    script(query);
    queries.push(query);
    return query;
  });
  return queries;
}

test.afterEach(() => {
  setClaudeQueryImplementation(null);
});

test('two turns of a session go through one process, which lives on until closed', async () => {
  const queries = installFakeSdk();
  const writer = createWriter();
  const context = createContext();
  const changes: SessionProcessSnapshot[] = [];
  const unsubscribe = onSessionProcessChange((snapshot) => changes.push(snapshot));

  await queryClaudeSDK('hello', { sessionId: 'app-1' }, writer, context);
  await queryClaudeSDK('again', { sessionId: 'app-1' }, writer, context);

  assert.equal(queries.length, 1, 'one process for both turns');
  assert.equal(queries[0].consumed.length, 2, 'both prompts went to its stdin');
  assert.equal(queries[0].options.resume, undefined, 'a new session is not resumed');
  assert.deepEqual(writer.frames.filter((frame) => frame.kind === 'complete').length, 2);
  assert.equal(writer.frames.filter((frame) => frame.kind === 'session_created').length, 1);
  assert.deepEqual(writer.ids, ['sid-1']);
  assert.equal(getSessionProcess('app-1')?.state, 'chat');
  assert.equal(queries[0].exited, false, 'the process stays after the turn');

  assert.equal(await closeClaudeSDKSession('app-1'), true);
  assert.equal(queries[0].exited, true, 'close ends its stdin');
  assert.equal(getSessionProcess('app-1'), null);
  assert.deepEqual(changes.map((change) => change.state), ['chat', 'off']);
  unsubscribe();
});

test('a resumed session starts its process with the provider id', async () => {
  const queries = installFakeSdk((query) => { query.onInput = () => query.answer('sid-9'); });
  const writer = createWriter();
  const context = createContext({ resolveProviderSessionId: () => 'sid-9' });

  await queryClaudeSDK('hello', { sessionId: 'app-9' }, writer, context);

  assert.equal(queries[0].options.resume, 'sid-9');
  assert.equal(writer.frames.some((frame) => frame.kind === 'session_created'), false);
  await closeClaudeSDKSession('app-9');
});

test('abort interrupts the turn and keeps the process', async () => {
  const queries = installFakeSdk((query) => { query.onInput = () => {}; });
  const writer = createWriter();
  const context = createContext();

  const turn = queryClaudeSDK('hello', { sessionId: 'app-2' }, writer, context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await abortClaudeSDKSession('app-2'), true, 'abort returns once the CLI took the interrupt');
  assert.equal(queries[0].interrupts, 1);
  let turnSettled = false;
  void turn.then(() => { turnSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(turnSettled, false, 'the turn stays open until its own result');
  // The interrupted turn still ends with its own result.
  queries[0].emit({ type: 'result', subtype: 'success', session_id: 'sid-2' });
  await turn;

  assert.equal(writer.frames.some((frame) => frame.kind === 'complete'), false, 'the abort handler sends the complete');
  assert.equal(queries[0].exited, false);
  assert.equal(getSessionProcess('app-2')?.state, 'chat');

  // The next turn goes to the same process.
  queries[0].onInput = () => queries[0].answer('sid-2');
  await queryClaudeSDK('next', { sessionId: 'app-2' }, writer, context);
  assert.equal(queries.length, 1);
  await closeClaudeSDKSession('app-2');
});

test('editing a sent message replaces the process', async () => {
  const queries = installFakeSdk();
  const writer = createWriter();
  const context = createContext({ resolveProviderSessionId: () => 'sid-3' });

  await queryClaudeSDK('hello', { sessionId: 'app-3' }, writer, context);
  await queryClaudeSDK('edited', { sessionId: 'app-3', resumeAnchorId: 'row-7' }, writer, context);

  assert.equal(queries.length, 2);
  assert.equal(queries[0].exited, true, 'the first process was closed');
  assert.equal(queries[1].options.resumeSessionAt, 'row-7');
  assert.equal(getSessionProcess('app-3')?.state, 'chat');
  await closeClaudeSDKSession('app-3');
});

test('model and permission mode change on the live process', async () => {
  const queries = installFakeSdk();
  const writer = createWriter();
  const context = createContext();

  await queryClaudeSDK('hello', { sessionId: 'app-4', model: 'sonnet' }, writer, context);
  await queryClaudeSDK('again', { sessionId: 'app-4', model: 'opus', permissionMode: 'plan' }, writer, context);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].models, ['opus']);
  assert.deepEqual(queries[0].modes, ['plan']);
  await closeClaudeSDKSession('app-4');
});

test('a direct caller without an app session gets a process for one turn', async () => {
  const queries = installFakeSdk((query) => { query.onInput = () => query.answer('sid-5'); });
  const writer = { ...createWriter(), isSSEStreamWriter: true, isWebSocketWriter: false };
  const context = createContext();

  await queryClaudeSDK('hello', {}, writer, context);
  await untilExited(queries[0]);

  assert.equal(queries[0].exited, true, 'stdin ends at the result');
  assert.equal(getSessionProcess('sid-5'), null, 'not a session process');
});

test('a process that dies under a turn reports the error and completes', async () => {
  const queries = installFakeSdk((query) => {
    query.onInput = () => {
      query.emit({ type: 'system', subtype: 'init', session_id: 'sid-6' });
      query.emit({ type: 'assistant', session_id: 'sid-6', message: { role: 'assistant', content: [] } });
    };
  });
  const writer = createWriter();
  const context = createContext();

  const turn = queryClaudeSDK('hello', { sessionId: 'app-6' }, writer, context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The CLI goes away mid-turn.
  (queries[0] as unknown as { output: { end(): void } }).output.end();
  await turn;

  const complete = writer.frames.find((frame) => frame.kind === 'complete');
  assert.ok(complete, 'the client still gets a terminal complete');
  assert.equal(getSessionProcess('app-6'), null);
});
