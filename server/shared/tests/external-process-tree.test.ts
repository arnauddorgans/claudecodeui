import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeExternalProcesses,
  EXTERNAL_PROCESS_LIMIT,
  EXTERNAL_PROCESS_MIN_AGE_MS,
  parseProcessTable,
  PROCESS_TABLE_CACHE_TTL_MS,
  PROCESS_TABLE_IDLE_TIMEOUT_MS,
  processIsAlive,
  readProcessTable,
  resetProcessTableCacheForTests,
  walkExternalProcesses,
  type DescribeExternalProcessesDependencies,
  type ProcessTableRow,
  type ReadProcessTableDependencies,
} from '@/shared/external-process-tree.js';

const NOW = Date.parse('2026-09-17T20:58:22Z');

/** Lets a promise's `.then`/`.catch`/`.finally` chain settle before asserting on it. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

// readProcessTable used to run `ps` synchronously on every cache miss, blocking the
// event loop for the spawn's duration. It now only ever reads a cache a background
// timer maintains — these tests prove the call itself never waits on a subprocess,
// and that the edges (cold start, in-flight refresh, a failing `ps`) stay honest.
const PS_OUTPUT_ONE_ROW = ' 100     1   100 Wed Sep 17 20:57:22 2026 claude\n';

test('readProcessTable returns immediately even while the async ps runner never resolves', (t) => {
  resetProcessTableCacheForTests();
  t.after(() => resetProcessTableCacheForTests());

  const deps: ReadProcessTableDependencies = {
    execFile: () => new Promise(() => {}), // deliberately never settles
  };
  const start = Date.now();
  const rows = readProcessTable(NOW, deps);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 50, `expected an immediate return, took ${elapsed}ms`);
  assert.deepEqual(rows, []);
});

test('readProcessTable reports nothing before the first background refresh completes (cold start)', async (t) => {
  resetProcessTableCacheForTests();
  t.after(() => resetProcessTableCacheForTests());

  const pending: { resolveExec: ((value: { stdout: string; stderr: string }) => void) | null } = {
    resolveExec: null,
  };
  const deps: ReadProcessTableDependencies = {
    execFile: () =>
      new Promise((resolve) => {
        pending.resolveExec = resolve;
      }),
  };

  assert.deepEqual(readProcessTable(NOW, deps), []);

  pending.resolveExec?.({ stdout: PS_OUTPUT_ONE_ROW, stderr: '' });
  await flush();

  assert.deepEqual(readProcessTable(NOW, {}), parseProcessTable(PS_OUTPUT_ONE_ROW));
});

test('several calls in the same window cost one ps, not one each', async (t) => {
  resetProcessTableCacheForTests();
  t.after(() => resetProcessTableCacheForTests());

  let calls = 0;
  const deps: ReadProcessTableDependencies = {
    execFile: () => {
      calls += 1;
      return Promise.resolve({ stdout: PS_OUTPUT_ONE_ROW, stderr: '' });
    },
  };

  readProcessTable(NOW, deps);
  await flush();
  readProcessTable(NOW, {});
  readProcessTable(NOW, {});
  readProcessTable(NOW, {});

  assert.equal(calls, 1);
  assert.deepEqual(readProcessTable(NOW, {}), parseProcessTable(PS_OUTPUT_ONE_ROW));
});

test('a failing ps leaves the cache at [] rather than throwing', async (t) => {
  resetProcessTableCacheForTests();
  t.after(() => resetProcessTableCacheForTests());

  const deps: ReadProcessTableDependencies = {
    execFile: () => Promise.reject(new Error('ps: command not found')),
  };

  const cold = readProcessTable(NOW, deps);
  assert.deepEqual(cold, []);

  await flush();

  assert.deepEqual(readProcessTable(NOW, {}), []);
});

test('a dependency that throws synchronously is handled the same as a rejected spawn', (t) => {
  resetProcessTableCacheForTests();
  t.after(() => resetProcessTableCacheForTests());

  const deps: ReadProcessTableDependencies = {
    execFile: () => {
      throw new Error('spawn EAGAIN');
    },
  };

  assert.deepEqual(readProcessTable(NOW, deps), []);
});

test('a call landing while a refresh is in flight gets the previous cache, not a wait', async (t) => {
  resetProcessTableCacheForTests();
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => resetProcessTableCacheForTests());

  let call = 0;
  const pending: { resolveSecond: ((value: { stdout: string; stderr: string }) => void) | null } = {
    resolveSecond: null,
  };
  const deps: ReadProcessTableDependencies = {
    execFile: () => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({ stdout: PS_OUTPUT_ONE_ROW, stderr: '' });
      }
      return new Promise((resolve) => {
        pending.resolveSecond = resolve;
      });
    },
  };

  readProcessTable(NOW, deps); // primes the cache and starts the background timer
  await flush();
  assert.deepEqual(readProcessTable(NOW, {}), parseProcessTable(PS_OUTPUT_ONE_ROW));

  t.mock.timers.tick(PROCESS_TABLE_CACHE_TTL_MS); // fires the next refresh, which now hangs
  await flush();

  const duringFlight = readProcessTable(NOW, {});
  assert.deepEqual(duringFlight, parseProcessTable(PS_OUTPUT_ONE_ROW));

  pending.resolveSecond?.({ stdout: '', stderr: '' });
  await flush();
  assert.deepEqual(readProcessTable(NOW, {}), []);
});

test('the background refresh lapses after enough idle time, and a new call restarts it', async (t) => {
  resetProcessTableCacheForTests();
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  t.after(() => resetProcessTableCacheForTests());

  let calls = 0;
  const deps: ReadProcessTableDependencies = {
    execFile: () => {
      calls += 1;
      return Promise.resolve({ stdout: PS_OUTPUT_ONE_ROW, stderr: '' });
    },
  };

  readProcessTable(NOW, deps); // the only call; everything else is the timer running on its own
  await flush();
  assert.equal(calls, 1);

  // node:test's mock Date jumps straight to the target of one big tick() rather than
  // advancing per fire, which would make every interval callback in the batch see the
  // same (already-expired) elapsed time. Ticking one TTL at a time, flushing between,
  // mirrors how the real clock advances one fire at a time.
  const ticksInsideGracePeriod = Math.floor(PROCESS_TABLE_IDLE_TIMEOUT_MS / PROCESS_TABLE_CACHE_TTL_MS);
  for (let i = 0; i < ticksInsideGracePeriod; i += 1) {
    t.mock.timers.tick(PROCESS_TABLE_CACHE_TTL_MS);
    await flush();
  }
  const callsWhileStillWatched = calls;
  assert.ok(callsWhileStillWatched > 1, 'kept refreshing on its own inside the idle grace period');

  for (let i = 0; i < 3; i += 1) {
    t.mock.timers.tick(PROCESS_TABLE_CACHE_TTL_MS);
    await flush();
  }
  assert.equal(calls, callsWhileStillWatched, 'no further ps calls once the timer let itself lapse');

  readProcessTable(NOW, deps);
  await flush();
  assert.equal(calls, callsWhileStillWatched + 1, 'a new call restarts the refresh cycle');
});

// The cache the background refresh maintains is up to a TTL plus one `ps` behind
// reality, and a lapsed refresh leaves one behind with no bound on its age at all.
// Measured on the live "pro" instance: `/api/providers/sessions/running` reported
// 20 `externalProcesses` for a busy session, 7 of whose pids `ps -p` said were
// already gone. So what is served is confirmed against the kernel at serve time,
// and a lapsed refresh's table is not served as if it were current.
const PS_OUTPUT_TREE =
  [
    ' 100     1   100 Wed Sep 17 20:57:22 2026 claude',
    ' 200   100   200 Wed Sep 17 20:57:24 2026 /bin/zsh',
    ' 300   200   200 Wed Sep 17 20:57:26 2026 /bin/sleep',
    '',
  ].join('\n');

/** A fake process table plus a liveness set the test can kill entries out of. */
function depsForTree(alive: Set<number>): DescribeExternalProcessesDependencies {
  return {
    execFile: () => Promise.resolve({ stdout: PS_OUTPUT_TREE, stderr: '' }),
    isAlive: (pid: number) => alive.has(pid),
  };
}

test('a descendant that died since the last refresh is not listed as still running', async (t) => {
  resetProcessTableCacheForTests();
  t.after(() => resetProcessTableCacheForTests());

  const alive = new Set([100, 200, 300]);
  const deps = depsForTree(alive);

  readProcessTable(NOW, deps); // primes the cache from that table
  await flush();
  assert.deepEqual(describeExternalProcesses(100, NOW, deps).map((p) => p.pid), [200, 300]);

  // The `sleep` exits. The cached table still carries its row until the next refresh.
  alive.delete(300);

  assert.deepEqual(describeExternalProcesses(100, NOW, deps).map((p) => p.pid), [200]);
});

test('a dead parent is dropped without dropping the live subtree under it', async (t) => {
  resetProcessTableCacheForTests();
  t.after(() => resetProcessTableCacheForTests());

  // The shell exited but the `sleep` it started outlives it, reparented by the
  // kernel — the cached table still shows it under the shell.
  const alive = new Set([100, 300]);
  const deps = depsForTree(alive);

  readProcessTable(NOW, deps);
  await flush();

  assert.deepEqual(describeExternalProcesses(100, NOW, deps).map((p) => p.pid), [300]);
});

test('every entry dying leaves an empty list, not the last one that was reported', async (t) => {
  resetProcessTableCacheForTests();
  t.after(() => resetProcessTableCacheForTests());

  const alive = new Set([100, 200, 300]);
  const deps = depsForTree(alive);

  readProcessTable(NOW, deps);
  await flush();
  assert.equal(describeExternalProcesses(100, NOW, deps).length, 2);

  alive.delete(200);
  alive.delete(300);

  assert.deepEqual(describeExternalProcesses(100, NOW, deps), []);
});

test('the table a lapsed refresh left behind is not served as if it were current', async (t) => {
  resetProcessTableCacheForTests();
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  t.after(() => resetProcessTableCacheForTests());

  const deps: ReadProcessTableDependencies = {
    execFile: () => Promise.resolve({ stdout: PS_OUTPUT_ONE_ROW, stderr: '' }),
  };

  readProcessTable(NOW, deps);
  await flush();
  assert.deepEqual(readProcessTable(NOW, deps), parseProcessTable(PS_OUTPUT_ONE_ROW));

  // Nothing calls for long enough that the refresh lets itself stop. Whatever it
  // last read is now of unbounded age: the machine has moved on since.
  const ticksToLapse = Math.floor(PROCESS_TABLE_IDLE_TIMEOUT_MS / PROCESS_TABLE_CACHE_TTL_MS) + 3;
  for (let i = 0; i < ticksToLapse; i += 1) {
    t.mock.timers.tick(PROCESS_TABLE_CACHE_TTL_MS);
    await flush();
  }

  assert.deepEqual(readProcessTable(NOW, deps), [], 'the first call after a lapse reports nothing');

  await flush(); // the same call restarted the refresh; one `ps` later there is a table again
  assert.deepEqual(readProcessTable(NOW, deps), parseProcessTable(PS_OUTPUT_ONE_ROW));
});

test('processIsAlive says yes for this very process and no for a pid that cannot exist', () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive(-1), false);
});

test('walkExternalProcesses keeps its pure default: every row in the table is live', () => {
  // The fabricated pids of the tests above are not processes on this machine, so
  // the walk's own default has to stay "the table is the truth" — the liveness
  // probe belongs to describeExternalProcesses, which knows the pids are real.
  const rows: ProcessTableRow[] = [
    rowAt(100_000_001, 1, 60_000, 'claude'),
    rowAt(100_000_002, 100_000_001, 60_000, 'zsh'),
  ];

  assert.deepEqual(walkExternalProcesses(rows, 100_000_001, NOW).map((p) => p.pid), [100_000_002]);
});

test('describeExternalProcesses reports nothing for a session with no captured cli pid', () => {
  assert.deepEqual(describeExternalProcesses(0, NOW), []);
});
