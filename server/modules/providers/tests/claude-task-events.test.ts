import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * The SDK's task events, shaped after `SDKTaskStartedMessage`,
 * `SDKTaskUpdatedMessage`, `SDKTaskProgressMessage` and
 * `SDKTaskNotificationMessage` in `@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
 */
const started = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'task-1',
  tool_use_id: 'toolu_1',
  description: 'List the files',
  subagent_type: 'Explore',
  task_type: 'subagent',
  uuid: 'u-started',
  session_id: 'sid',
};

const provider = new ClaudeSessionsProvider();
const normalize = (raw: unknown) => provider.normalizeMessage(raw, 'sid');

test('task_started becomes a started task frame with what the event names', () => {
  const [frame, ...rest] = normalize(started);
  assert.equal(rest.length, 0);
  assert.equal(frame.kind, 'task');
  assert.equal(frame.id, 'u-started');
  assert.equal(frame.sessionId, 'sid');
  assert.equal(frame.taskId, 'task-1');
  assert.equal(frame.toolUseId, 'toolu_1');
  assert.equal(frame.description, 'List the files');
  assert.equal(frame.agentType, 'Explore');
  assert.equal(frame.taskType, 'subagent');
  assert.equal(frame.status, 'started');
  assert.equal(frame.background, false);
  assert.equal('summary' in frame, false, 'nothing the event did not say');
});

test('task_updated carries only its patch, in the shared status vocabulary', () => {
  const [backgrounded] = normalize({
    type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { is_backgrounded: true, status: 'running' }, uuid: 'u-1', session_id: 'sid',
  });
  assert.deepEqual(
    { taskId: backgrounded.taskId, status: backgrounded.status, background: backgrounded.background, description: backgrounded.description },
    { taskId: 'task-1', status: 'running', background: true, description: undefined },
  );

  const [killed] = normalize({
    type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'killed', error: 'stopped by user' }, uuid: 'u-2', session_id: 'sid',
  });
  assert.equal(killed.status, 'stopped');
  assert.equal(killed.summary, 'stopped by user');

  const [paused] = normalize({
    type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'paused' }, uuid: 'u-3', session_id: 'sid',
  });
  assert.equal(paused.status, 'running', 'a paused task is still running as far as the process goes');

  const [described] = normalize({
    type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { description: 'renamed' }, uuid: 'u-4', session_id: 'sid',
  });
  assert.equal(described.status, undefined, 'no status in the patch, none on the frame');
  assert.equal(described.description, 'renamed');
});

test('task_progress is a running task with its usage', () => {
  const [frame] = normalize({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-1',
    tool_use_id: 'toolu_1',
    description: 'List the files',
    subagent_type: 'Explore',
    usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4500 },
    last_tool_name: 'Bash',
    uuid: 'u-progress',
    session_id: 'sid',
  });
  assert.equal(frame.kind, 'task');
  assert.equal(frame.status, 'running');
  assert.deepEqual(frame.usage, { totalTokens: 1200, toolUses: 3, durationMs: 4500 });
  assert.equal(frame.agentType, 'Explore');
  // What it is busy with now, not a new name for the task.
  assert.equal(frame.progress, 'List the files');
  assert.equal(frame.description, undefined);
});

test('task_notification ends the task with its outcome and summary', () => {
  const base = {
    type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'toolu_1', output_file: '/tmp/out', session_id: 'sid',
  };
  const [completed] = normalize({ ...base, status: 'completed', summary: 'Three files found', usage: { total_tokens: 2000, tool_uses: 4, duration_ms: 9000 }, uuid: 'u-done' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.summary, 'Three files found');
  assert.deepEqual(completed.usage, { totalTokens: 2000, toolUses: 4, durationMs: 9000 });
  assert.equal(completed.outputFile, '/tmp/out', 'the one event that names where the task wrote');

  const [failed] = normalize({ ...base, status: 'failed', summary: 'boom', uuid: 'u-failed' });
  assert.equal(failed.status, 'failed');
  const [stopped] = normalize({ ...base, status: 'stopped', summary: 'stopped', uuid: 'u-stopped' });
  assert.equal(stopped.status, 'stopped');
});

test('a subagent task event keeps the tool call that spawned the agent', () => {
  const [frame] = normalize({ ...started, parent_tool_use_id: 'toolu_parent' });
  assert.equal(frame.parentToolUseId, 'toolu_parent');
});

test('other system events and task events without an id produce nothing', () => {
  assert.deepEqual(normalize({ type: 'system', subtype: 'init', session_id: 'sid' }), []);
  assert.deepEqual(normalize({ type: 'system', subtype: 'task_started', description: 'no id', session_id: 'sid' }), []);
  assert.deepEqual(normalize({ type: 'system', subtype: 'background_tasks_changed', session_id: 'sid' }), []);
});
