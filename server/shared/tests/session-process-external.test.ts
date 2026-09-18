import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSessionProcessExternalProcessesEnabled } from '@/shared/session-process-external.js';

test('resolveSessionProcessExternalProcessesEnabled defaults to off when unset', () => {
  assert.equal(resolveSessionProcessExternalProcessesEnabled(undefined), false);
});

test('resolveSessionProcessExternalProcessesEnabled is on only for "true"', () => {
  assert.equal(resolveSessionProcessExternalProcessesEnabled('true'), true);
  assert.equal(resolveSessionProcessExternalProcessesEnabled('TRUE'), true);
  assert.equal(resolveSessionProcessExternalProcessesEnabled(' true '), true);
  assert.equal(resolveSessionProcessExternalProcessesEnabled('1'), false);
  assert.equal(resolveSessionProcessExternalProcessesEnabled('false'), false);
  assert.equal(resolveSessionProcessExternalProcessesEnabled(''), false);
});
