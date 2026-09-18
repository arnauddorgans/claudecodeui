import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * One row of the process table, as `ps -axo pid=,ppid=,lstart=,comm=`
 * reports it: pid, parent pid, when it started, and its executable's name
 * (macOS gives `comm` as a full path; Linux truncates it to 15 chars — both
 * are reduced to a basename, never the command line, which can hold secrets).
 */
export type ProcessTableRow = {
  pid: number;
  ppid: number;
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

/** How long a process-table read is reused before the next `ps` runs. */
const PROCESS_TABLE_CACHE_TTL_MS = 1000;

// `Www Mon Dd hh:mm:ss YYYY`, e.g. "Wed Sep 17 20:58:22 2026" — five
// whitespace-separated tokens, both on macOS and Linux `ps`.
const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+?)\s*$/;

/**
 * Parses `ps -axo pid=,ppid=,lstart=,comm=` output into rows. `comm` is left
 * whole here (a bundle name can hold spaces, e.g. "Google Chrome Helper");
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
    const [, pidStr, ppidStr, lstart, comm] = match;
    const started = new Date(lstart);
    rows.push({
      pid: Number.parseInt(pidStr, 10),
      ppid: Number.parseInt(ppidStr, 10),
      startedAt: Number.isNaN(started.getTime()) ? null : started.getTime(),
      name: path.basename(comm),
    });
  }
  return rows;
}

export type ReadProcessTableDependencies = {
  execFileSync?: typeof execFileSync;
};

let cache: { rows: ProcessTableRow[]; expiresAt: number } | null = null;

/**
 * Reads the process table once, cached for `PROCESS_TABLE_CACHE_TTL_MS` so
 * several `describeExternalProcesses` calls a second (one chat process can
 * back `chat_subscribed`, `session_process` and `/sessions/running` calls in
 * quick succession) cost one `ps`, not one each.
 */
export function readProcessTable(
  now: number = Date.now(),
  deps: ReadProcessTableDependencies = {},
): ProcessTableRow[] {
  if (cache && now < cache.expiresAt) {
    return cache.rows;
  }
  const run = deps.execFileSync ?? execFileSync;
  let rows: ProcessTableRow[] = [];
  try {
    const output = run('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8' }) as string;
    rows = parseProcessTable(output);
  } catch {
    // No process table this cycle (e.g. `ps` missing): report nothing rather than throw.
    rows = [];
  }
  cache = { rows, expiresAt: now + PROCESS_TABLE_CACHE_TTL_MS };
  return rows;
}

/** Test-only: forces the next `readProcessTable` call to re-run `ps`. */
export function resetProcessTableCacheForTests(): void {
  cache = null;
}

/**
 * Walks the process table from `rootPid` (exclusive, never itself listed)
 * and returns every live descendant older than `EXTERNAL_PROCESS_MIN_AGE_MS`,
 * breadth-first, capped at `EXTERNAL_PROCESS_LIMIT`. Pure and synchronous so
 * a fabricated table can drive it directly in tests.
 */
export function walkExternalProcesses(
  rows: ProcessTableRow[],
  rootPid: number,
  now: number = Date.now(),
): ExternalProcess[] {
  const children = new Map<number, ProcessTableRow[]>();
  for (const row of rows) {
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
 * capped at 20 — what `SessionProcessSnapshot.externalProcesses` reports.
 * Nothing to clean up here: this only observes the process table.
 */
export function describeExternalProcesses(rootPid: number, now: number = Date.now()): ExternalProcess[] {
  if (!rootPid) {
    return [];
  }
  return walkExternalProcesses(readProcessTable(now), rootPid, now);
}
