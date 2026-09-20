import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * One row of the process table, as `ps -axo pid=,ppid=,pgid=,lstart=,comm=`
 * reports it: pid, parent pid, process-group id, when it started, and its
 * executable's name (macOS gives `comm` as a full path; Linux truncates it to
 * 15 chars — both are reduced to a basename, never the command line, which can
 * hold secrets).
 */
export type ProcessTableRow = {
  pid: number;
  ppid: number;
  /** Process-group id — what tells the CLI's own infrastructure from a turn's work. */
  pgid: number;
  /** Epoch milliseconds the process started, or `null` when `lstart` did not parse. */
  startedAt: number | null;
  name: string;
};

/** What `SessionProcessSnapshot.externalProcesses` reports for one descendant. */
export type ExternalProcess = {
  pid: number;
  name: string;
  /** Epoch milliseconds. */
  startedAt: number;
};

/** A descendant younger than this is still starting up and is left out. */
export const EXTERNAL_PROCESS_MIN_AGE_MS = 5000;

/** `externalProcesses` never lists more than this many entries. */
export const EXTERNAL_PROCESS_LIMIT = 20;

/** How often the background refresh re-runs `ps` while something is asking for it. */
export const PROCESS_TABLE_CACHE_TTL_MS = 1000;

/**
 * How long the background refresh keeps running with nobody calling
 * `readProcessTable`/`describeExternalProcesses` before it lets itself stop.
 * A live session polls at least every second or two (`chat_subscribed`,
 * `session_process` broadcasts, `/sessions/running`), so a handful of missed
 * ticks means nothing is watching any more — better to stop spawning `ps`
 * on a timer nobody reads than to keep a process alive that outlives its
 * last caller by design.
 */
export const PROCESS_TABLE_IDLE_TIMEOUT_MS = PROCESS_TABLE_CACHE_TTL_MS * 5;

const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,lstart=,comm='] as const;

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: { encoding: BufferEncoding },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as ExecFileAsync;

// `Www Mon Dd hh:mm:ss YYYY`, e.g. "Wed Sep 17 20:58:22 2026" — five
// whitespace-separated tokens, both on macOS and Linux `ps`.
const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+?)\s*$/;

/**
 * Parses `ps -axo pid=,ppid=,pgid=,lstart=,comm=` output into rows. `comm` is
 * left whole here (a bundle name can hold spaces, e.g. "Google Chrome Helper");
 * callers reduce it to a basename.
 */
export function parseProcessTable(output: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const match = PS_LINE_RE.exec(line);
    if (!match) {
      continue;
    }
    const [, pidStr, ppidStr, pgidStr, lstart, comm] = match;
    const started = new Date(lstart);
    rows.push({
      pid: Number.parseInt(pidStr, 10),
      ppid: Number.parseInt(ppidStr, 10),
      pgid: Number.parseInt(pgidStr, 10),
      startedAt: Number.isNaN(started.getTime()) ? null : started.getTime(),
      name: path.basename(comm),
    });
  }
  return rows;
}

export type ReadProcessTableDependencies = {
  /**
   * Overrides the async `ps` runner the background refresh uses. Test-only:
   * production always uses the real `execFile`, promisified.
   */
  execFile?: ExecFileAsync;
};

/**
 * The last successfully (or unsuccessfully) read process table, or `null`
 * before the first background refresh has ever completed. `readProcessTable`
 * never spawns anything itself, so `null` and "`ps` just failed" both read
 * the same way to a caller: nothing to report.
 */
let cache: ProcessTableRow[] | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight = false;
let lastRequestAt = 0;
let activeExecFile: ExecFileAsync = execFileAsync;

/**
 * Spawns `ps` asynchronously and replaces `cache` with the result, unless a
 * spawn is already on the wire — in which case this tick is skipped and the
 * previous cache stands, rather than piling up overlapping `ps` calls.
 */
function refreshProcessTableOnce(): void {
  if (refreshInFlight) {
    return;
  }
  refreshInFlight = true;
  let pending: Promise<{ stdout: string }>;
  try {
    pending = activeExecFile('ps', PS_ARGS, { encoding: 'utf8' });
  } catch {
    // A dependency that throws synchronously instead of rejecting: same
    // "nothing to report" outcome as a rejected spawn.
    cache = [];
    refreshInFlight = false;
    return;
  }
  pending
    .then(({ stdout }) => {
      cache = parseProcessTable(stdout);
    })
    .catch(() => {
      // No process table this cycle (e.g. `ps` missing): report nothing rather than throw.
      cache = [];
    })
    .finally(() => {
      refreshInFlight = false;
    });
}

/**
 * Starts the background refresh on the first call and leaves it running,
 * unref'd, for as long as something keeps calling — then lets it lapse.
 * Lazy-start-and-lapse over one interval for the process's whole life: this
 * module is only ever exercised while `SESSION_PROCESS_EXTERNAL_PROCESSES`
 * is on and a session is live, so a server that never enables the setting,
 * or sits with no session open, never pays for a `ps` every second.
 */
function ensureRefreshScheduled(deps: ReadProcessTableDependencies): void {
  if (deps.execFile) {
    activeExecFile = deps.execFile;
  }
  lastRequestAt = Date.now();
  if (refreshTimer) {
    return;
  }
  refreshProcessTableOnce();
  refreshTimer = setInterval(() => {
    if (Date.now() - lastRequestAt > PROCESS_TABLE_IDLE_TIMEOUT_MS) {
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
      refreshTimer = null;
      return;
    }
    refreshProcessTableOnce();
  }, PROCESS_TABLE_CACHE_TTL_MS);
  refreshTimer.unref?.();
}

/**
 * Returns whatever the background refresh currently has cached — never runs
 * `ps` itself, so this never blocks on a subprocess. Before the first
 * refresh completes (cold start) this is `[]`: under-reporting is the same
 * choice `walkExternalProcesses` makes below when the CLI's own row is
 * missing, and for the same reason. If a refresh is in flight when this is
 * called, the previous cache is returned rather than waiting on it.
 */
export function readProcessTable(
  now: number = Date.now(),
  deps: ReadProcessTableDependencies = {},
): ProcessTableRow[] {
  void now; // kept for interface stability; the cache now runs on its own wall-clock schedule.
  ensureRefreshScheduled(deps);
  return cache ?? [];
}

/**
 * Test-only: drops the cache and stops the background refresh so a fresh
 * `readProcessTable(now, deps)` call starts a new one with new
 * dependencies, and no interval leaks into the next test.
 */
export function resetProcessTableCacheForTests(): void {
  cache = null;
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = null;
  refreshInFlight = false;
  lastRequestAt = 0;
  activeExecFile = execFileAsync;
}

/**
 * Walks the process table from `rootPid` (exclusive, never itself listed)
 * and returns every live descendant older than `EXTERNAL_PROCESS_MIN_AGE_MS`,
 * breadth-first, capped at `EXTERNAL_PROCESS_LIMIT`. Pure and synchronous so
 * a fabricated table can drive it directly in tests.
 *
 * A session's own infrastructure is dropped, with its subtree: MCP servers and
 * language servers stay in the CLI's process group, while the CLI starts each
 * Bash tool call detached, as its own group leader, so it can signal the whole
 * tree. So a descendant whose `pgid` is the CLI's own is the session running
 * itself; one that leads its own group is the turn's work, and everything
 * below it (a build's sub-processes, a `tail` beside it) inherits that group.
 * Pruning infrastructure with its subtree is what also removes, say, a Python
 * process a language server spawned into a group of its own.
 *
 * The comparison is against the CLI's group rather than a fixed value, so it
 * holds whether or not the CLI was itself spawned detached. If the CLI's own
 * row is missing — a `ps` read racing session shutdown — nothing is pruned:
 * listing too much reads as a busy session, listing nothing reads as an idle
 * one, and the second is the worse lie. It needs no log line: the same race
 * usually takes the descendants' rows with it, so the list is empty anyway.
 */
export function walkExternalProcesses(
  rows: ProcessTableRow[],
  rootPid: number,
  now: number = Date.now(),
): ExternalProcess[] {
  const children = new Map<number, ProcessTableRow[]>();
  let cliPgid: number | null = null;
  for (const row of rows) {
    if (row.pid === rootPid) {
      cliPgid = row.pgid;
    }
    if (row.pid === row.ppid) {
      // Self-parented rows (pid 0/1 on some systems) can't be a descendant of anything.
      continue;
    }
    const siblings = children.get(row.ppid);
    if (siblings) {
      siblings.push(row);
    } else {
      children.set(row.ppid, [row]);
    }
  }

  const result: ExternalProcess[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: ProcessTableRow[] = [...(children.get(rootPid) ?? [])];

  while (queue.length > 0 && result.length < EXTERNAL_PROCESS_LIMIT) {
    const row = queue.shift() as ProcessTableRow;
    if (seen.has(row.pid)) {
      // A corrupt or racily-read table could otherwise cycle forever.
      continue;
    }
    seen.add(row.pid);

    if (cliPgid !== null && row.pgid === cliPgid) {
      // The session running itself, not work it was asked to do: skip the row
      // and its subtree, which belongs to the same piece of infrastructure.
      continue;
    }

    const age = row.startedAt === null ? Number.POSITIVE_INFINITY : now - row.startedAt;
    if (age > EXTERNAL_PROCESS_MIN_AGE_MS) {
      result.push({ pid: row.pid, name: row.name, startedAt: row.startedAt ?? now });
    }
    queue.push(...(children.get(row.pid) ?? []));
  }

  return result;
}

/**
 * The session's CLI process's live OS descendants, older than 5 seconds,
 * capped at 20, minus the session's own infrastructure — what
 * `SessionProcessSnapshot.externalProcesses` reports.
 * Nothing to clean up here: this only observes the process table.
 */
export function describeExternalProcesses(rootPid: number, now: number = Date.now()): ExternalProcess[] {
  if (!rootPid) {
    return [];
  }
  return walkExternalProcesses(readProcessTable(now), rootPid, now);
}
