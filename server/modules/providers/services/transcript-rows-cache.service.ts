import fsp from 'node:fs/promises';

import { noSessionHistoryTiming } from '@/modules/providers/services/session-history-timing.service.js';
import type { AnyRecord, SessionHistoryTiming } from '@/shared/types.js';

/**
 * Parsed rows of an append-only JSONL transcript, kept between reads so a
 * transcript that grew is read from where the last read stopped.
 *
 * `sessionHistoryCache` keeps a session's normalized history, but only for as
 * long as the file is exactly the size it was: a session that is being written
 * to misses it on every read, and each miss re-read and re-parsed the whole
 * file. For a 228 MB transcript that was ~550 ms of the ~1 s every history read
 * cost — on every reconnect of every client, while the session was live.
 *
 * An entry remembers how many bytes it consumed (up to the last newline), the
 * file's inode and the bytes just before that offset. A read whose file is the
 * same inode, at least that long, with those same bytes in place, parses only
 * what follows; anything else — a smaller file, a replaced one, a rewrite under
 * the offset — reads the whole file again. A last line with no newline yet (the
 * CLI mid-write) is parsed for this read and not kept, so the next read sees it
 * whole.
 *
 * The rows are shared between reads, so callers must not mutate them: copy a
 * row before changing it.
 */

type Entry = {
  ino: number;
  dev: number;
  /** Bytes consumed, always just past a newline. */
  offset: number;
  /** The bytes just before `offset`, compared on the next read. */
  guard: Buffer;
  /** Every complete row, unfiltered, in file order. */
  rows: AnyRecord[];
  /** Rows carrying each `sessionId` value, cached by filter. */
  bySession: Map<string, AnyRecord[]>;
};

type ReadArgs = {
  filePath: string;
  /** Keeps only rows whose `sessionId` is this one; null keeps every row. */
  sessionId: string | null;
  timing?: SessionHistoryTiming;
  /** Prefix of the counters this read records (`readBytes`, `readLines`, `readRows`). */
  label?: string;
};

const GUARD_BYTES = 256;
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Small files re-parse in a few milliseconds: not worth the memory. */
const MIN_CACHED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_FILE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 4;

function parseLine(text: string): AnyRecord | null {
  if (!text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as AnyRecord) : null;
  } catch {
    // A row can be half-written while the CLI is streaming into the file.
    return null;
  }
}

/**
 * Reads `[start, end)` and parses its complete lines. Returns the rows, the
 * offset just past the last newline, the parsed trailing fragment (if any),
 * and how many lines were seen.
 */
async function readRange(filePath: string, start: number, end: number): Promise<{
  rows: AnyRecord[];
  consumedTo: number;
  tail: AnyRecord | null;
  lines: number;
  bytesRead: number;
}> {
  const rows: AnyRecord[] = [];
  let lines = 0;
  let bytesRead = 0;
  let consumedTo = start;
  let carry: Buffer = Buffer.alloc(0);
  const handle = await fsp.open(filePath, 'r');
  try {
    let position = start;
    while (position < end) {
      const length = Math.min(CHUNK_BYTES, end - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead: got } = await handle.read(chunk, 0, length, position);
      if (got === 0) {
        break;
      }
      bytesRead += got;
      position += got;
      const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
      let lineStart = 0;
      let newline = data.indexOf(0x0a, lineStart);
      while (newline !== -1) {
        lines += 1;
        const row = parseLine(data.toString('utf8', lineStart, newline));
        if (row) {
          rows.push(row);
        }
        lineStart = newline + 1;
        newline = data.indexOf(0x0a, lineStart);
      }
      consumedTo = position - (data.length - lineStart);
      // Copied, so the carried fragment does not pin the whole chunk.
      carry = Buffer.from(data.subarray(lineStart));
    }
  } finally {
    await handle.close();
  }

  let tail: AnyRecord | null = null;
  if (carry.length > 0) {
    lines += 1;
    tail = parseLine(carry.toString('utf8'));
  }
  return { rows, consumedTo, tail, lines, bytesRead };
}

async function readGuard(filePath: string, offset: number): Promise<Buffer> {
  const length = Math.min(GUARD_BYTES, offset);
  const buffer = Buffer.alloc(length);
  if (length === 0) {
    return buffer;
  }
  const handle = await fsp.open(filePath, 'r');
  try {
    await handle.read(buffer, 0, length, offset - length);
  } finally {
    await handle.close();
  }
  return buffer;
}

function filterRows(entry: Entry, sessionId: string | null): AnyRecord[] {
  if (sessionId === null) {
    return entry.rows;
  }
  let filtered = entry.bySession.get(sessionId);
  if (!filtered) {
    filtered = entry.rows.filter((row) => row.sessionId === sessionId);
    entry.bySession.set(sessionId, filtered);
  }
  return filtered;
}

export function createTranscriptRowsCache({
  minFileBytes = MIN_CACHED_FILE_BYTES,
  maxTotalFileBytes = MAX_CACHED_FILE_BYTES,
  maxEntries = MAX_ENTRIES,
}: { minFileBytes?: number; maxTotalFileBytes?: number; maxEntries?: number } = {}) {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<unknown>>();

  function evictOverBudget(): void {
    let total = 0;
    for (const entry of entries.values()) {
      total += entry.offset;
    }
    for (const key of entries.keys()) {
      if (entries.size <= 1 || (total <= maxTotalFileBytes && entries.size <= maxEntries)) {
        break;
      }
      total -= entries.get(key)!.offset;
      entries.delete(key);
    }
  }

  async function readUncoalesced({ filePath, sessionId, timing, label }: Required<ReadArgs>): Promise<AnyRecord[]> {
    const stat = await fsp.stat(filePath);
    let entry = entries.get(filePath);

    if (entry) {
      const sameFile = entry.ino === stat.ino && entry.dev === stat.dev && stat.size >= entry.offset;
      const intact = sameFile && (await readGuard(filePath, entry.offset)).equals(entry.guard);
      if (!intact) {
        timing.note('rowsCacheMiss', sameFile ? 'rewritten' : 'replaced');
        entries.delete(filePath);
        entry = undefined;
      }
    }

    const start = entry?.offset ?? 0;
    const range = await readRange(filePath, start, stat.size);
    timing.note('rowsCache', !entry ? 'full' : range.bytesRead > 0 ? 'append' : 'hit');
    timing.count(`${label}Bytes`, range.bytesRead);
    timing.count(`${label}Lines`, range.lines);

    if (!entry) {
      entry = {
        ino: stat.ino,
        dev: stat.dev,
        offset: range.consumedTo,
        guard: await readGuard(filePath, range.consumedTo),
        rows: range.rows,
        bySession: new Map(),
      };
      if (range.consumedTo >= minFileBytes) {
        entries.set(filePath, entry);
        evictOverBudget();
      }
    } else if (range.consumedTo > entry.offset) {
      for (const row of range.rows) {
        entry.rows.push(row);
      }
      for (const [filterId, filtered] of entry.bySession) {
        for (const row of range.rows) {
          if (row.sessionId === filterId) {
            filtered.push(row);
          }
        }
      }
      entry.offset = range.consumedTo;
      entry.guard = await readGuard(filePath, range.consumedTo);
      // Most recently used last.
      entries.delete(filePath);
      entries.set(filePath, entry);
    }

    const rows = filterRows(entry, sessionId).slice();
    if (range.tail && (sessionId === null || range.tail.sessionId === sessionId)) {
      rows.push(range.tail);
    }
    timing.count(`${label}Rows`, rows.length);
    return rows;
  }

  return {
    /**
     * The transcript's rows (filtered by `sessionId`), in file order, as a
     * fresh array of shared row objects.
     */
    async readRows(args: ReadArgs): Promise<AnyRecord[]> {
      const full: Required<ReadArgs> = {
        timing: noSessionHistoryTiming,
        label: 'read',
        ...args,
      } as Required<ReadArgs>;
      // Reads of one file run one at a time: two appends racing on one entry
      // would push the same rows twice.
      const previous = pending.get(args.filePath) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => readUncoalesced(full));
      pending.set(args.filePath, current);
      try {
        return await current;
      } finally {
        if (pending.get(args.filePath) === current) {
          pending.delete(args.filePath);
        }
      }
    },
    /** For tests. */
    size(): number {
      return entries.size;
    },
  };
}

export const transcriptRowsCache = createTranscriptRowsCache();
