import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeClaudeSDKSession,
  getSessionProcess,
  onSessionProcessChange,
  queryClaudeSDK,
  setClaudeQueryImplementation,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord, ProviderRuntimeContext, SessionProcessSnapshot } from '@/shared/types.js';

const provider = new ClaudeSessionsProvider();
const normalize = (raw: unknown) => provider.normalizeMessage(raw, 'sid');

// ---------------------------
//----------------- THE NORMALIZERS ------------

test('a status event becomes an activity status frame that tells compacting from requesting', () => {
  const [compacting, ...rest] = normalize({
    type: 'system', subtype: 'status', status: 'compacting', uuid: 'u-1', session_id: 'sid',
  });
  assert.equal(rest.length, 0);
  assert.equal(compacting.kind, 'status');
  assert.equal(compacting.text, 'activity');
  assert.equal(compacting.activity, 'compacting');
  assert.equal(compacting.id, 'u-1');
  assert.equal(compacting.sessionId, 'sid');

  const [requesting] = normalize({ type: 'system', subtype: 'status', status: 'requesting', uuid: 'u-2', session_id: 'sid' });
  assert.equal(requesting.activity, 'requesting');

  const [idle] = normalize({ type: 'system', subtype: 'status', status: null, uuid: 'u-3', session_id: 'sid' });
  assert.equal(idle.activity, null, 'the CLI saying it is doing neither travels as null');

  const [unknown] = normalize({ type: 'system', subtype: 'status', status: 'brand_new', uuid: 'u-4', session_id: 'sid' });
  assert.equal(unknown.activity, null, 'a status this fork does not know reads as idle, never as itself');
});

test('the frame that ends a compaction carries how it went, and nothing it did not say', () => {
  const [ok] = normalize({
    type: 'system', subtype: 'status', status: null, compact_result: 'success', permissionMode: 'plan', uuid: 'u-5', session_id: 'sid',
  });
  assert.equal(ok.compactResult, 'success');
  assert.equal(ok.permissionMode, 'plan');
  assert.equal('compactError' in ok, false);

  const [failed] = normalize({
    type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'context too small', uuid: 'u-6', session_id: 'sid',
  });
  assert.equal(failed.compactResult, 'failed');
  assert.equal(failed.compactError, 'context too small');
  assert.equal('permissionMode' in failed, false);
});

test('a thinking_tokens event becomes a status frame carrying the running total only', () => {
  const [frame, ...rest] = normalize({
    type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1234, estimated_tokens_delta: 56, uuid: 'u-7', session_id: 'sid',
  });
  assert.equal(rest.length, 0);
  assert.equal(frame.kind, 'status');
  assert.equal(frame.text, 'thinking_tokens');
  assert.equal(frame.thinkingTokens, 1234);
  assert.equal('estimated_tokens_delta' in frame, false, 'the delta is the increment, not something a client adds up');

  assert.deepEqual(normalize({ type: 'system', subtype: 'thinking_tokens', session_id: 'sid' }), [], 'no estimate, no frame');
});

test('a tool_use_summary event becomes a frame naming the calls it captions', () => {
  const [frame, ...rest] = normalize({
    type: 'tool_use_summary',
    summary: 'Read the three config files and found the port',
    preceding_tool_use_ids: ['toolu_1', 'toolu_2', 'toolu_3'],
    uuid: 'u-8',
    session_id: 'sid',
  });
  assert.equal(rest.length, 0);
  assert.equal(frame.kind, 'tool_use_summary');
  assert.equal(frame.id, 'u-8');
  assert.equal(frame.summary, 'Read the three config files and found the port');
  assert.deepEqual(frame.precedingToolUseIds, ['toolu_1', 'toolu_2', 'toolu_3']);

  const [noIds] = normalize({ type: 'tool_use_summary', summary: 'Looked around', session_id: 'sid' });
  assert.deepEqual(noIds.precedingToolUseIds, [], 'a summary tied to nothing is still a summary');

  assert.deepEqual(normalize({ type: 'tool_use_summary', preceding_tool_use_ids: ['toolu_1'], session_id: 'sid' }), [], 'no sentence, no frame');
});

// ---------------------------
//----------------- THE RUNTIME ------------

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
  readonly options: AnyRecord;
  private readonly output = createChannel<AnyRecord>();

  constructor(prompt: AsyncIterable<AnyRecord>, options: AnyRecord) {
    this.options = options;
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

function createWriter() {
  const frames: AnyRecord[] = [];
  return {
    frames,
    userId: null,
    isWebSocketWriter: true,
    send(data: unknown) { frames.push(data as AnyRecord); },
    setSessionId() {},
  };
}

function createContext(): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId, requested) => requested ?? undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
    normalizeMessage: (raw, sessionId) => provider.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
}

function installFakeSdk(script: (query: FakeQuery) => void) {
  const queries: FakeQuery[] = [];
  setClaudeQueryImplementation((args: AnyRecord) => {
    const query = new FakeQuery(args.prompt as AsyncIterable<AnyRecord>, args.options as AnyRecord);
    script(query);
    queries.push(query);
    return query;
  });
  return queries;
}

/** Waits for a session's process to be announced: launching one reads config files, so it takes a moment. */
async function untilProcess(sessionId: string): Promise<void> {
  for (let i = 0; i < 200 && !getSessionProcess(sessionId); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

test.beforeEach(() => {
  process.env.SESSION_PROCESS_CLOSE = 'manual';
});

test.afterEach(() => {
  setClaudeQueryImplementation(null);
  delete process.env.SESSION_PROCESS_CLOSE;
});

test('every summary of a turn reaches the client, and the record keeps the last one', async () => {
  const queries = installFakeSdk((query) => {
    query.onInput = () => {
      query.emit({ type: 'system', subtype: 'init', session_id: 'sid-a' });
      query.emit({
        type: 'tool_use_summary', summary: 'Read the config', preceding_tool_use_ids: ['toolu_1'], uuid: 'u-a1', session_id: 'sid-a',
      });
      query.emit({
        type: 'tool_use_summary', summary: 'Ran the tests and they passed', preceding_tool_use_ids: ['toolu_2', 'toolu_3'], uuid: 'u-a2', session_id: 'sid-a',
      });
    };
  });
  const writer = createWriter();

  const turn = queryClaudeSDK('go', { sessionId: 'app-a' }, writer, createContext());
  await untilProcess('app-a');
  await settle();

  const summaries = writer.frames.filter((frame) => frame.kind === 'tool_use_summary');
  assert.equal(summaries.length, 2, 'each summary is its own frame, not a rolling status');
  assert.deepEqual(
    summaries.map((frame) => [frame.summary, frame.precedingToolUseIds]),
    [['Read the config', ['toolu_1']], ['Ran the tests and they passed', ['toolu_2', 'toolu_3']]],
    'each carries the calls it is about',
  );

  const activity = getSessionProcess('app-a')?.activity;
  assert.equal(activity?.summary, 'Ran the tests and they passed', 'a client arriving now reads the latest');
  assert.deepEqual(activity?.summaryToolUseIds, ['toolu_2', 'toolu_3']);

  queries[0].emit({ type: 'result', subtype: 'success', session_id: 'sid-a' });
  await turn;
  await closeClaudeSDKSession('app-a');
});

test('a compaction is announced as it starts and as it ends, and never looks like silence', async () => {
  const queries = installFakeSdk((query) => {
    query.onInput = () => {
      query.emit({ type: 'system', subtype: 'init', session_id: 'sid-b' });
      query.emit({ type: 'system', subtype: 'status', status: 'requesting', uuid: 'u-b1', session_id: 'sid-b' });
      query.emit({ type: 'system', subtype: 'status', status: 'compacting', uuid: 'u-b2', session_id: 'sid-b' });
    };
  });
  const writer = createWriter();
  const changes: SessionProcessSnapshot[] = [];
  const unsubscribe = onSessionProcessChange((snapshot) => changes.push(snapshot));

  const turn = queryClaudeSDK('go', { sessionId: 'app-b' }, writer, createContext());
  await untilProcess('app-b');
  await settle();

  assert.deepEqual(
    writer.frames.filter((frame) => frame.kind === 'status').map((frame) => [frame.text, frame.activity]),
    [['activity', 'requesting'], ['activity', 'compacting']],
  );
  assert.equal(getSessionProcess('app-b')?.activity?.status, 'compacting', 'the long quiet stretch has a name on the record');
  assert.deepEqual(
    changes.map((change) => change.activity?.status ?? 'none'),
    ['none', 'requesting', 'compacting'],
    'every status change is announced to every client, the launch included',
  );

  // The compaction ends and the model goes back to waiting on the API.
  queries[0].emit({ type: 'system', subtype: 'status', status: 'requesting', compact_result: 'success', uuid: 'u-b3', session_id: 'sid-b' });
  await settle();

  const back = writer.frames.filter((frame) => frame.kind === 'status').at(-1);
  assert.equal(back?.activity, 'requesting');
  assert.equal(back?.compactResult, 'success');
  assert.equal(getSessionProcess('app-b')?.activity?.status, 'requesting');
  assert.equal(getSessionProcess('app-b')?.activity?.compactResult, 'success');
  assert.equal(changes.length, 4);

  queries[0].emit({ type: 'result', subtype: 'success', session_id: 'sid-b' });
  await turn;
  await closeClaudeSDKSession('app-b');
  unsubscribe();
});

test('what the model was doing is the turn\'s, and the process between turns says nothing', async () => {
  const queries = installFakeSdk((query) => {
    query.onInput = () => {
      query.emit({ type: 'system', subtype: 'init', session_id: 'sid-c' });
      query.emit({ type: 'system', subtype: 'status', status: 'requesting', uuid: 'u-c1', session_id: 'sid-c' });
      query.emit({ type: 'tool_use_summary', summary: 'Listed the files', preceding_tool_use_ids: ['toolu_1'], uuid: 'u-c2', session_id: 'sid-c' });
      query.emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 900, estimated_tokens_delta: 900, uuid: 'u-c3', session_id: 'sid-c' });
    };
  });
  const writer = createWriter();

  const turn = queryClaudeSDK('go', { sessionId: 'app-c' }, writer, createContext());
  await untilProcess('app-c');
  await settle();

  const during = getSessionProcess('app-c')?.activity;
  assert.deepEqual(
    { status: during?.status, summary: during?.summary, thinkingTokens: during?.thinkingTokens },
    { status: 'requesting', summary: 'Listed the files', thinkingTokens: 900 },
  );

  queries[0].emit({ type: 'result', subtype: 'success', session_id: 'sid-c' });
  await turn;

  const after = getSessionProcess('app-c');
  assert.equal(after?.state, 'chat', 'the process is still there');
  assert.equal(after?.activity, undefined, 'and it is doing nothing, rather than still saying what it did');
  assert.equal(
    'activity' in (after as unknown as AnyRecord),
    false,
    'the field is absent between turns, not an object full of nulls',
  );

  // None of the three was ever written to the transcript, so a client that
  // reconnects after the turn has no way back to them — by design: the reply
  // it narrated is in the transcript and is the better account.
  await closeClaudeSDKSession('app-c');
});

test('thinking-token estimates are throttled on the wire but not on the record', async () => {
  const queries = installFakeSdk((query) => {
    query.onInput = () => {
      query.emit({ type: 'system', subtype: 'init', session_id: 'sid-d' });
      for (const estimated of [120, 260, 410, 780]) {
        query.emit({
          type: 'system', subtype: 'thinking_tokens', estimated_tokens: estimated, estimated_tokens_delta: 10, uuid: `u-d${estimated}`, session_id: 'sid-d',
        });
      }
    };
  });
  const writer = createWriter();

  const turn = queryClaudeSDK('go', { sessionId: 'app-d' }, writer, createContext());
  await untilProcess('app-d');
  await settle();

  const ticks = () => writer.frames.filter((frame) => frame.kind === 'status' && frame.text === 'thinking_tokens');
  assert.deepEqual(ticks().map((frame) => frame.thinkingTokens), [120], 'the first shows the pill at once, the rest are noise within the second');
  assert.equal(getSessionProcess('app-d')?.activity?.thinkingTokens, 780, 'the record still has the real number');

  // A total no larger than the last one is a new thinking block, which gets
  // its own first frame rather than waiting out the interval.
  queries[0].emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 40, estimated_tokens_delta: 40, uuid: 'u-d-next', session_id: 'sid-d' });
  await settle();
  assert.deepEqual(ticks().map((frame) => frame.thinkingTokens), [120, 40]);

  queries[0].emit({ type: 'result', subtype: 'success', session_id: 'sid-d' });
  await turn;
  await closeClaudeSDKSession('app-d');
});
