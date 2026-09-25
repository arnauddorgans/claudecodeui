import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeClaudeSDKSession,
  getSessionProcess,
  onSelfStartedTurn,
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

/** Stands in for the SDK's `query()`: reads the prompt stream and emits what the test scripts. */
class FakeQuery {
  consumed: AnyRecord[] = [];
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

  /**
   * The turn the CLI runs on its own when a background task reports back: the
   * `<task-notification>` it injects as a user record, its reply, the result.
   */
  answerUnprompted(sessionId: string): void {
    this.emit({
      type: 'user',
      session_id: sessionId,
      message: { role: 'user', content: '<task-notification><status>completed</status></task-notification>' },
    });
    this.emit({
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    this.emit({ type: 'result', subtype: 'success', session_id: sessionId });
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

function createWriter() {
  const frames: AnyRecord[] = [];
  return {
    frames,
    userId: null,
    isWebSocketWriter: true,
    send(data: unknown) { frames.push(data as AnyRecord); },
    setSessionId() {},
    kinds() { return frames.map((frame) => String(frame.kind)); },
  };
}

function createContext(): ProviderRuntimeContext {
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
  };
}

function installFakeSdk() {
  const queries: FakeQuery[] = [];
  setClaudeQueryImplementation((args: AnyRecord) => {
    const query = new FakeQuery(args.prompt as AsyncIterable<AnyRecord>, args.options as AnyRecord);
    query.onInput = () => query.answer('sid-bg');
    queries.push(query);
    return query;
  });
  return queries;
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test.beforeEach(() => {
  process.env.SESSION_PROCESS_CLOSE = 'manual';
});

test.afterEach(() => {
  setClaudeQueryImplementation(null);
  delete process.env.SESSION_PROCESS_CLOSE;
});

test('a turn the CLI starts by itself runs on a writer of its own and ends with a complete', async () => {
  const queries = installFakeSdk();
  const sent = createWriter();
  const unprompted = createWriter();
  const asked: string[] = [];
  const uninstall = onSelfStartedTurn((sessionId) => {
    asked.push(sessionId);
    return unprompted;
  });
  const changes: SessionProcessSnapshot[] = [];
  const unsubscribe = onSessionProcessChange((snapshot) => changes.push(snapshot));

  await queryClaudeSDK('hello', { sessionId: 'app-bg' }, sent, createContext());
  assert.equal(sent.kinds().filter((kind) => kind === 'complete').length, 1);
  const sentAfterItsTurn = sent.frames.length;

  // The background task reported back: the CLI answers something nobody sent.
  queries[0].answerUnprompted('sid-bg');
  await until(() => unprompted.kinds().includes('complete'));

  assert.deepEqual(asked, ['app-bg'], 'the gateway was asked for a run, by app session id');
  assert.ok(unprompted.kinds().includes('text'), 'the reply went out on the new run');
  assert.equal(unprompted.kinds().filter((kind) => kind === 'complete').length, 1, 'exactly one terminal complete');
  assert.equal(sent.frames.length, sentAfterItsTurn, 'nothing of it reached the finished run');
  assert.ok(changes.some((change) => change.turnActive), 'the session showed a turn in flight');
  assert.equal(changes.at(-1)?.turnActive, false, 'and stopped showing one when it ended');
  assert.equal(getSessionProcess('app-bg')?.turnActive, false);

  uninstall();
  unsubscribe();
  await closeClaudeSDKSession('app-bg');
});

test('with no run to open, the unprompted turn reports back as it did before', async () => {
  const queries = installFakeSdk();
  const sent = createWriter();
  const uninstall = onSelfStartedTurn(() => null);

  await queryClaudeSDK('hello', { sessionId: 'app-bg-2' }, sent, createContext());
  const completes = sent.kinds().filter((kind) => kind === 'complete').length;

  queries[0].answerUnprompted('sid-bg');
  await until(() => sent.kinds().filter((kind) => kind === 'text').length > 1);

  assert.equal(
    sent.kinds().filter((kind) => kind === 'complete').length,
    completes,
    'no second complete is invented for the run that already ended',
  );

  uninstall();
  await closeClaudeSDKSession('app-bg-2');
});

test("a subagent's messages after the turn do not open one", async () => {
  const queries = installFakeSdk();
  const sent = createWriter();
  const unprompted = createWriter();
  let asked = 0;
  const uninstall = onSelfStartedTurn(() => { asked += 1; return unprompted; });

  await queryClaudeSDK('hello', { sessionId: 'app-bg-3' }, sent, createContext());

  // A background Agent call keeps streaming past the turn that started it.
  queries[0].emit({
    type: 'assistant',
    parent_tool_use_id: 'toolu_agent',
    session_id: 'sid-bg',
    message: { role: 'assistant', content: [{ type: 'text', text: 'agent' }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(asked, 0, 'a subagent belongs to its task, not to a turn of the session');
  assert.equal(unprompted.frames.length, 0);

  uninstall();
  await closeClaudeSDKSession('app-bg-3');
});
