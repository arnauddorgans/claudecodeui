import assert from 'node:assert/strict';
import test from 'node:test';

import { describeProcess } from '@/modules/providers/list/claude/claude-runtime.provider.js';

/** Only the fields `describeProcess` reads. */
function fakeProc(cliPid: number | null) {
  return {
    key: 'app-external',
    startedAt: Date.now(),
    providerSessionId: 'sid-external',
    turn: null,
    tasks: new Map(),
    cliPid,
  };
}

test.afterEach(() => {
  delete process.env.SESSION_PROCESS_EXTERNAL_PROCESSES;
});

test('externalProcesses is absent from the snapshot when the setting is off (default)', () => {
  const snapshot = describeProcess(fakeProc(process.pid), 'chat');
  assert.equal('externalProcesses' in snapshot, false);
});

test('externalProcesses is absent when explicitly set to a non-"true" value', () => {
  process.env.SESSION_PROCESS_EXTERNAL_PROCESSES = 'nope';
  const snapshot = describeProcess(fakeProc(process.pid), 'chat');
  assert.equal('externalProcesses' in snapshot, false);
});

test('externalProcesses rides on the snapshot when the setting is on and a pid was captured', () => {
  process.env.SESSION_PROCESS_EXTERNAL_PROCESSES = 'true';
  const snapshot = describeProcess(fakeProc(process.pid), 'chat');
  assert.ok('externalProcesses' in snapshot);
  assert.ok(Array.isArray(snapshot.externalProcesses));
});

test('externalProcesses stays absent when the setting is on but no pid was captured', () => {
  process.env.SESSION_PROCESS_EXTERNAL_PROCESSES = 'true';
  const snapshot = describeProcess(fakeProc(null), 'chat');
  assert.equal('externalProcesses' in snapshot, false);
});

test('tasks and the rest of the snapshot are unaffected by the setting', () => {
  process.env.SESSION_PROCESS_EXTERNAL_PROCESSES = 'true';
  const snapshot = describeProcess(fakeProc(process.pid), 'chat');
  assert.equal(snapshot.sessionId, 'app-external');
  assert.equal(snapshot.state, 'chat');
  assert.deepEqual(snapshot.tasks, []);
});
