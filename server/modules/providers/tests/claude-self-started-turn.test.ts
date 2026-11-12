import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeClaudeSDKSession,
  getSessionProcess,
  onSelfStartedTurn,
  onSessionProcessChange,
  queryClaudeSDK,
  startsSelfStartedTurn,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import type { AnyRecord, ProviderRuntimeContext, SessionProcessSnapshot } from '@/shared/types.js';

/**
 * Under SESSION_PROCESS_CLOSE=manual the process outlives the turn, so the CLI
 * can start a turn of its own — replying to the `<task-notification>` it
 * injects when a background task ends. That turn gets a run of its own from
 * the gateway (`onSelfStartedTurn`) and ends with a `complete`.
 */

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
  return { stream, push(value: T) { queue.push(value); wake?.(); }, end() { ended = true; wake?.(); } };
}

const SID = 'sid-bg';

class FakeQuery {
  exited = false;
  private readonly output = createChannel<AnyRecord>();

  constructor(prompt: AsyncIterable<unknown>) {
    void (async () => {
      for await (const _message of prompt) {
        this.answer();
      }
      this.exited = true;
      this.output.end();
    })();
  }

  emit(message: AnyRecord): void { this.output.push(message); }

  answer(): void {
    this.emit({ type: 'system', subtype: 'init', session_id: SID });
    this.emit({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
    this.emit({ type: 'result', subtype: 'success', session_id: SID });
  }

  /** What the CLI does when a background task reports back: init, the reply, the result. */
  answerUnprompted(first: AnyRecord = { type: 'system', subtype: 'init', session_id: SID }): void {
    this.emit(first);
    this.emit({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] } });
    this.emit({ type: 'result', subtype: 'success', session_id: SID });
  }

  async interrupt(): Promise<void> {}
  async stopTask(): Promise<void> {}

  [Symbol.asyncIterator]() { return this.output.stream[Symbol.asyncIterator](); }
}

function createWriter() {
  const frames: AnyRecord[] = [];
  return {
    frames,
    // A real user id would make the run notifications read the database.
    userId: null,
    isWebSocketWriter: true,
    send(data: unknown) { frames.push(data as AnyRecord); },
    setSessionId() {},
    kinds() { return frames.map((frame) => String(frame.kind)); },
  };
}

function createContext() {
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
    createQuery: ({ prompt }) => {
      const query = new FakeQuery(prompt);
      queries.push(query);
      return query as never;
    },
  };
  return { context, queries };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), 'condition never became true');
}

test.before(async () => {
  process.env.CLAUDE_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), 'claude-self-started-'));
});

test.beforeEach(() => {
  process.env.SESSION_PROCESS_CLOSE = 'manual';
});

test.afterEach(() => {
  delete process.env.SESSION_PROCESS_CLOSE;
});

test('a turn the CLI starts by itself runs on a writer of its own and ends with a complete', async () => {
  const { context, queries } = createContext();
  const first = createWriter();
  const own = createWriter();
  const opened: Array<[string, unknown]> = [];
  const unhook = onSelfStartedTurn((sessionId, userId) => { opened.push([sessionId, userId]); return own; });
  const changes: SessionProcessSnapshot[] = [];
  const unsubscribe = onSessionProcessChange((snapshot) => changes.push(snapshot));

  await queryClaudeSDK('start a sleep', { sessionId: 'app-bg' }, first as never, context);
  const before = first.frames.length;
  changes.length = 0;

  queries[0].answerUnprompted();
  await until(() => own.kinds().includes('complete'));

  assert.deepEqual(opened, [['app-bg', null]], 'opened once, for the session, as its last user');
  assert.deepEqual(own.kinds(), ['text', 'complete']);
  assert.equal(first.frames.length, before, 'nothing more on the finished turn\'s writer');
  assert.deepEqual(changes.map((change) => change.turnActive), [true, false], 'turnActive goes true, then false');
  assert.equal(getSessionProcess('app-bg')?.turnActive, false);

  unsubscribe();
  unhook();
  await closeClaudeSDKSession('app-bg');
});

test('with no run to open, the unprompted turn reports back as it did before', async () => {
  const { context, queries } = createContext();
  const first = createWriter();
  const unhook = onSelfStartedTurn(() => null);

  await queryClaudeSDK('start a sleep', { sessionId: 'app-refused' }, first as never, context);
  const completes = first.kinds().filter((kind) => kind === 'complete').length;
  queries[0].answerUnprompted();
  await until(() => first.kinds().filter((kind) => kind === 'text').length === 2);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(first.kinds().filter((kind) => kind === 'complete').length, completes, 'no second complete');
  unhook();
  await closeClaudeSDKSession('app-refused');
});

test('the next client turn still goes to the same process after an unprompted one', async () => {
  const { context, queries } = createContext();
  const first = createWriter();
  const own = createWriter();
  const unhook = onSelfStartedTurn(() => own);

  await queryClaudeSDK('start', { sessionId: 'app-next' }, first as never, context);
  queries[0].answerUnprompted();
  await until(() => own.kinds().includes('complete'));
  const second = createWriter();
  await queryClaudeSDK('and now?', { sessionId: 'app-next' }, second as never, context);

  assert.equal(queries.length, 1);
  assert.deepEqual(second.kinds(), ['text', 'complete']);
  unhook();
  await closeClaudeSDKSession('app-next');
});

test('which messages open a turn of the session\'s own', () => {
  assert.equal(startsSelfStartedTurn({ type: 'system', subtype: 'init' }), true);
  assert.equal(startsSelfStartedTurn({ type: 'system', subtype: 'thinking_tokens' }), true);
  assert.equal(startsSelfStartedTurn({ type: 'user', message: {} }), true);
  assert.equal(startsSelfStartedTurn({ type: 'assistant', message: {} }), true);
  assert.equal(startsSelfStartedTurn({ type: 'stream_event' }), true);
  // A subagent's traffic belongs to the task that spawned it.
  assert.equal(startsSelfStartedTurn({ type: 'assistant', parent_tool_use_id: 'tu-1', message: {} }), false);
  // Background bookkeeping between turns.
  for (const subtype of ['task_started', 'task_progress', 'task_updated', 'task_notification', 'hook_response']) {
    assert.equal(startsSelfStartedTurn({ type: 'system', subtype }), false, subtype);
  }
  assert.equal(startsSelfStartedTurn({ type: 'result' }), false);
  assert.equal(startsSelfStartedTurn({ type: 'tool_progress' }), false);
  assert.equal(startsSelfStartedTurn({ type: 'prompt_suggestion' }), false);
});

test('background bookkeeping between turns opens no run', async () => {
  const { context, queries } = createContext();
  const first = createWriter();
  let opened = 0;
  const unhook = onSelfStartedTurn(() => { opened += 1; return createWriter(); });

  await queryClaudeSDK('start', { sessionId: 'app-quiet' }, first as never, context);
  queries[0].emit({ type: 'system', subtype: 'task_progress', session_id: SID, task_id: 't', tool_use_id: 'tu' });
  queries[0].emit({ type: 'system', subtype: 'task_notification', session_id: SID, task_id: 't', tool_use_id: 'tu', status: 'completed' });
  queries[0].emit({ type: 'assistant', session_id: SID, parent_tool_use_id: 'tu', message: { role: 'assistant', content: [] } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(opened, 0);
  assert.equal(getSessionProcess('app-quiet')?.turnActive, false);
  unhook();
  await closeClaudeSDKSession('app-quiet');
});
