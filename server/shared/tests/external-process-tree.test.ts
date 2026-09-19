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

function rowAt(
  pid: number,
  ppid: number,
  ageMs: number,
  name = 'node',
  pgid = pid,
): ProcessTableRow {
  return { pid, ppid, pgid, startedAt: NOW - ageMs, name };
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
    { pid: 600, ppid: 1, pgid: 600, startedAt: NOW - 60_000, name: 'claude' },
    { pid: 601, ppid: 600, pgid: 601, startedAt: null, name: 'mystery' },
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
    '  100     1   100 Wed Sep 17 20:57:22 2026 claude',
    '  101   100   101 Wed Sep 17 20:58:12 2026 /Applications/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper',
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

// The shape a live session shows: the CLI in the node server's group, with its
// MCP and language servers beside it in that same group, while each Bash tool
// call leads a group of its own and everything it starts inherits that group.
const LIVE_TABLE: ProcessTableRow[] = [
  rowAt(67372, 95504, 600_000, 'claude', 95504), // the CLI, in the server's group
  rowAt(67429, 67372, 590_000, 'mcpbridge', 95504),
  rowAt(67437, 67372, 590_000, 'ditto', 95504), // an MCP server, not /usr/bin/ditto
  rowAt(80733, 67372, 400_000, 'sourcekit-lsp', 95504),
  rowAt(80904, 80733, 390_000, 'Python', 80904), // spawned by the language server, own group
  rowAt(38196, 67372, 300_000, 'zsh', 38196), // a Bash tool call, detached
  rowAt(38251, 38196, 290_000, 'xcodebuild', 38196),
  rowAt(38260, 38251, 280_000, 'tail', 38196),
];

test('walkExternalProcesses drops the session\'s own infrastructure, keeping the work subtree', () => {
  const result = walkExternalProcesses(LIVE_TABLE, 67372, NOW);

  assert.deepEqual(
    result.map((p) => p.name),
    ['zsh', 'xcodebuild', 'tail'],
  );
});

test('walkExternalProcesses prunes infrastructure with its subtree, own-group children included', () => {
  const result = walkExternalProcesses(LIVE_TABLE, 67372, NOW);

  // 80904 leads its own group, so only skipping sourcekit-lsp's row would keep it.
  assert.equal(result.some((p) => p.pid === 80904), false);
});

test('walkExternalProcesses reads the group off the CLI, so a detached CLI is judged the same', () => {
  const rows: ProcessTableRow[] = [
    rowAt(800, 700, 60_000, 'claude', 800), // CLI spawned detached: leads its own group
    rowAt(801, 800, 50_000, 'mcp-server', 800),
    rowAt(802, 800, 50_000, 'zsh', 802),
  ];

  const result = walkExternalProcesses(rows, 800, NOW);

  assert.deepEqual(result.map((p) => p.pid), [802]);
});

test('walkExternalProcesses keeps everything when the CLI\'s own row is missing', () => {
  const rows: ProcessTableRow[] = [
    rowAt(901, 900, 50_000, 'mcp-server', 95504),
    rowAt(902, 900, 50_000, 'zsh', 902),
  ];

  const result = walkExternalProcesses(rows, 900, NOW);

  assert.deepEqual(result.map((p) => p.pid), [901, 902]);
});

test('parseProcessTable reads the pgid column between ppid and lstart', () => {
  const output = [
    ' 67372 95504 95504 Wed Sep 17 20:57:22 2026 claude',
    ' 67437 67372 95504 Wed Sep 17 20:57:24 2026 /Users/me/fanatics-live-ios/automation/bin/ditto',
    ' 38196 67372 38196 Wed Sep 17 20:58:12 2026 /bin/zsh',
    '',
  ].join('\n');

  const rows = parseProcessTable(output);

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.pid, r.ppid, r.pgid]),
    [
      [67372, 95504, 95504],
      [67437, 67372, 95504],
      [38196, 67372, 38196],
    ],
  );
  assert.equal(rows[1].name, 'ditto');
});
