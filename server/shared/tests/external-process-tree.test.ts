import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTERNAL_PROCESS_LIMIT,
  EXTERNAL_PROCESS_MIN_AGE_MS,
  parseProcessTable,
  walkExternalProcesses,
  type ProcessTableRow,
} from '@/shared/external-process-tree.js';

const NOW = Date.parse('2026-09-17T20:58:22Z');

function rowAt(pid: number, ppid: number, ageMs: number, name = 'node'): ProcessTableRow {
  return { pid, ppid, startedAt: NOW - ageMs, name };
}

test('walkExternalProcesses returns descendants alive past the age floor, excluding the root', () => {
  const rows: ProcessTableRow[] = [
    rowAt(100, 1, 60_000, 'claude'), // the CLI itself (rootPid) — never listed
    rowAt(101, 100, 10_000, 'screencapture'),
    rowAt(102, 100, 3_000, 'xcodebuild'), // younger than the 5s floor
  ];

  const result = walkExternalProcesses(rows, 100, NOW);

  assert.deepEqual(result, [{ pid: 101, name: 'screencapture', startedAt: NOW - 10_000 }]);
});

test('walkExternalProcesses excludes an entry exactly at the age floor, includes just past it', () => {
  const rows: ProcessTableRow[] = [
    rowAt(200, 1, 60_000, 'claude'),
    rowAt(201, 200, EXTERNAL_PROCESS_MIN_AGE_MS, 'at-floor'),
    rowAt(202, 200, EXTERNAL_PROCESS_MIN_AGE_MS + 1, 'past-floor'),
  ];

  const result = walkExternalProcesses(rows, 200, NOW);

  assert.deepEqual(result.map((p) => p.name), ['past-floor']);
});

test('walkExternalProcesses walks grandchildren too, not just direct children', () => {
  const rows: ProcessTableRow[] = [
    rowAt(300, 1, 60_000, 'claude'),
    rowAt(301, 300, 30_000, 'bash'),
    rowAt(302, 301, 20_000, 'xcodebuild'),
  ];

  const result = walkExternalProcesses(rows, 300, NOW);

  assert.deepEqual(result.map((p) => p.pid), [301, 302]);
});

test('walkExternalProcesses ignores processes outside the root\'s subtree', () => {
  const rows: ProcessTableRow[] = [
    rowAt(400, 1, 60_000, 'claude'),
    rowAt(401, 400, 30_000, 'bash'),
    rowAt(999, 1, 30_000, 'unrelated-daemon'),
  ];

  const result = walkExternalProcesses(rows, 400, NOW);

  assert.deepEqual(result.map((p) => p.pid), [401]);
});

test('walkExternalProcesses caps the list at EXTERNAL_PROCESS_LIMIT', () => {
  const rows: ProcessTableRow[] = [rowAt(500, 1, 60_000, 'claude')];
  for (let i = 0; i < EXTERNAL_PROCESS_LIMIT + 10; i += 1) {
    rows.push(rowAt(501 + i, 500, 30_000, `child-${i}`));
  }

  const result = walkExternalProcesses(rows, 500, NOW);

  assert.equal(result.length, EXTERNAL_PROCESS_LIMIT);
});

test('walkExternalProcesses treats an unparsed start time as old enough to include', () => {
  const rows: ProcessTableRow[] = [
    { pid: 600, ppid: 1, startedAt: NOW - 60_000, name: 'claude' },
    { pid: 601, ppid: 600, startedAt: null, name: 'mystery' },
  ];

  const result = walkExternalProcesses(rows, 600, NOW);

  assert.deepEqual(result, [{ pid: 601, name: 'mystery', startedAt: NOW }]);
});

test('walkExternalProcesses on a root with no children returns nothing', () => {
  const rows: ProcessTableRow[] = [rowAt(700, 1, 60_000, 'claude')];

  assert.deepEqual(walkExternalProcesses(rows, 700, NOW), []);
});

test('parseProcessTable reads pid, ppid, lstart and comm, including a comm with spaces', () => {
  const output = [
    '  100     1 Wed Sep 17 20:57:22 2026 claude',
    '  101   100 Wed Sep 17 20:58:12 2026 /Applications/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper',
    '',
  ].join('\n');

  const rows = parseProcessTable(output);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 100);
  assert.equal(rows[0].ppid, 1);
  assert.equal(rows[0].name, 'claude');
  assert.equal(rows[1].pid, 101);
  assert.equal(rows[1].name, 'Google Chrome Helper');
  assert.equal(rows[1].startedAt, Date.parse('Wed Sep 17 20:58:12 2026'));
});

test('parseProcessTable drops a line it cannot parse instead of throwing', () => {
  const rows = parseProcessTable('garbage line with no numeric prefix\n');
  assert.deepEqual(rows, []);
});
