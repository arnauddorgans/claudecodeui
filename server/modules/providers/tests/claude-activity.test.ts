import assert from 'node:assert/strict';
import test from 'node:test';

import { createActivityRecorder, readClaudeActivityFrame } from '@/modules/providers/list/claude/claude-activity.js';

test('a status message becomes an activity frame, an unknown state reading as idle', () => {
  const compacting = readClaudeActivityFrame({ type: 'system', subtype: 'status', status: 'compacting', uuid: 'u1' }, 'native');
  assert.equal(compacting?.kind, 'status');
  assert.equal(compacting?.text, 'activity');
  assert.equal(compacting?.activity, 'compacting');
  assert.equal(compacting?.id, 'u1');

  const done = readClaudeActivityFrame({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'too big', permissionMode: 'plan' }, 'native');
  assert.equal(done?.activity, null);
  assert.equal(done?.compactResult, 'failed');
  assert.equal(done?.compactError, 'too big');
  assert.equal(done?.permissionMode, 'plan');

  assert.equal(readClaudeActivityFrame({ type: 'system', subtype: 'status', status: 'pondering' }, null)?.activity, null);
  assert.equal('compactResult' in (readClaudeActivityFrame({ type: 'system', subtype: 'status', status: 'requesting' }, null) ?? {}), false);
});

test('thinking tokens carry the running total, tool-use summaries their sentence and call ids', () => {
  const thinking = readClaudeActivityFrame({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 41.6 }, null);
  assert.equal(thinking?.text, 'thinking_tokens');
  assert.equal(thinking?.thinkingTokens, 42);
  assert.equal(readClaudeActivityFrame({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 'x' }, null), null);

  const summary = readClaudeActivityFrame({ type: 'tool_use_summary', summary: 'Read the config', preceding_tool_use_ids: ['tu-1', 2, ''] }, null);
  assert.equal(summary?.kind, 'tool_use_summary');
  assert.equal(summary?.summary, 'Read the config');
  assert.deepEqual(summary?.precedingToolUseIds, ['tu-1']);
  assert.equal(readClaudeActivityFrame({ type: 'tool_use_summary', summary: '' }, null), null, 'no sentence, no frame');
});

test('a subagent\'s activity and every other message are not activity frames', () => {
  assert.equal(readClaudeActivityFrame({ type: 'system', subtype: 'status', status: 'requesting', parent_tool_use_id: 'tu' }, null), null);
  assert.equal(readClaudeActivityFrame({ type: 'system', subtype: 'init' }, null), null);
  assert.equal(readClaudeActivityFrame({ type: 'assistant', message: {} }, null), null);
});

test('the recorder keeps the latest of each, throttles thinking tokens, and says when the state changed', () => {
  const recorder = createActivityRecorder();
  const thinking = (tokens: number) => readClaudeActivityFrame({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: tokens }, null)!;
  const status = (value: string | null) => readClaudeActivityFrame({ type: 'system', subtype: 'status', status: value }, null)!;

  assert.deepEqual(recorder.record(status('requesting')), { forward: true, changed: true });
  assert.deepEqual(recorder.record(status('requesting')), { forward: true, changed: false });
  assert.equal(recorder.record(thinking(10)).forward, true, 'the first of a block goes');
  assert.equal(recorder.record(thinking(20)).forward, false, 'within the second, held back');
  assert.equal(recorder.record(thinking(5)).forward, true, 'a smaller total is a new block');
  recorder.record(readClaudeActivityFrame({ type: 'tool_use_summary', summary: 'Ran the tests', preceding_tool_use_ids: ['a'] }, null)!);

  assert.deepEqual(recorder.snapshot(), { status: 'requesting', thinkingTokens: 5, summary: 'Ran the tests', summaryToolUseIds: ['a'] });
  recorder.clear();
  assert.equal(recorder.snapshot(), undefined, 'nothing between turns');
});
