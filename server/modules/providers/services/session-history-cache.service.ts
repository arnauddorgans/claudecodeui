import fsp from 'node:fs/promises';

import { noSessionHistoryTiming } from '@/modules/providers/services/session-history-timing.service.js';
import type { FetchHistoryResult, SessionHistoryTiming } from '@/shared/types.js';

/**
 * Full-transcript cache for session history reads.
 *
 * Every provider history reader materializes the complete normalized
 * transcript and then slices out the requested page, so serving a 20-row page
 * of a large session re-read and re-parsed the whole transcript file on every
 * request — opening a session, each older page while scrolling up, and every
 * post-turn refresh. For a multi-megabyte JSONL that is most of a second of
 * CPU per request.
 *
 * Entries are keyed by app session id and validated with one `stat` per
 * request against the transcript file's identity (path + mtime + size), so
 * only the first read after the file changes pays the parse. Anything that
 * rewrites history (a new turn, an edit, a rewind, a fork) touches the file
 * and invalidates naturally; no explicit invalidation hooks exist or are
 * needed.
 *
 * Only history readers that read `jsonl_path` itself may use this cache —
 * callers pass `transcriptPath: null` for providers whose messages live
 * elsewhere (Cursor's store.db, OpenCode's shared SQLite), which bypasses
 * caching entirely.
 */

type CacheEntry = {
  transcriptPath: string;
  mtimeMs: number;
  /** File size in bytes; doubles as the entry's cost against the byte budget. */
  size: number;
  full: FetchHistoryResult;
};

type GetFullHistoryArgs = {
  sessionId: string;
  /** Path of the file the provider's history reader actually parses, or null to bypass. */
  transcriptPath: string | null | undefined;
  /**
   * Loads the complete transcript (`limit: null, offset: 0`) from the provider,
   * inside the `load` phase — so the phases the reader opens on the recorder it
   * is handed are children of `load` rather than siblings of it.
   */
  loadFull: (timing: SessionHistoryTiming) => Promise<FetchHistoryResult>;
  /** Stopwatch for the request, when it is being measured. */
  timing?: SessionHistoryTiming;
};

/**
 * A transcript entry's heap cost is roughly the file it was parsed from, so
 * the budget is expressed in file bytes. The newest entry is always retained
 * even when it alone exceeds the budget — evicting it would just re-parse the
 * same file on the next request.
 */
const MAX_CACHED_TRANSCRIPT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;

export function createSessionHistoryCache(
  maxTotalFileBytes = MAX_CACHED_TRANSCRIPT_FILE_BYTES,
  maxEntries = MAX_CACHE_ENTRIES,
) {
  const entries = new Map<string, CacheEntry>();
  const pendingLoads = new Map<string, Promise<FetchHistoryResult>>();

  function evictOverBudget(): void {
    let totalBytes = 0;
    for (const entry of entries.values()) {
      totalBytes += entry.size;
    }
    for (const key of entries.keys()) {
      if (entries.size <= 1 || (totalBytes <= maxTotalFileBytes && entries.size <= maxEntries)) {
        break;
      }
      totalBytes -= entries.get(key)!.size;
      entries.delete(key);
    }
  }

  return {
    /**
     * Returns the session's full transcript through the cache, or null when
     * the session is not cacheable (no transcript path, or the file cannot be
     * stat'ed) — the caller then falls back to a plain provider read.
     */
    async getFullHistory({ sessionId, transcriptPath, loadFull, timing }: GetFullHistoryArgs): Promise<FetchHistoryResult | null> {
      const stopwatch = timing ?? noSessionHistoryTiming;
      if (!transcriptPath) {
        stopwatch.note('cache', 'bypass');
        return null;
      }

      let stat;
      try {
        stat = await stopwatch.phase('cacheStat', () => fsp.stat(transcriptPath));
      } catch {
        stopwatch.note('cache', 'bypass');
        stopwatch.note('cacheMiss', 'unstatable');
        entries.delete(sessionId);
        return null;
      }
      if (!stat.isFile()) {
        stopwatch.note('cache', 'bypass');
        stopwatch.note('cacheMiss', 'notAFile');
        entries.delete(sessionId);
        return null;
      }

      const cached = entries.get(sessionId);
      if (
        cached
        && cached.transcriptPath === transcriptPath
        && cached.mtimeMs === stat.mtimeMs
        && cached.size === stat.size
      ) {
        // Re-insert to mark as most recently used.
        entries.delete(sessionId);
        entries.set(sessionId, cached);
        stopwatch.note('cache', 'hit');
        return cached.full;
      }

      // Which of the three parts of the key changed is the difference between
      // a session that is merely open and one that is being written to.
      stopwatch.note('cache', 'miss');
      stopwatch.note(
        'cacheMiss',
        !cached
          ? 'absent'
          : cached.transcriptPath !== transcriptPath
            ? 'path'
            : cached.size !== stat.size
              ? 'size'
              : 'mtime',
      );
      stopwatch.count('cachedBytesBefore', cached?.size ?? 0);
      stopwatch.count('transcriptBytes', stat.size);

      // Concurrent requests for the same session share one parse. The file may
      // gain rows while the load runs; the pre-load stat is what the entry is
      // keyed by, so the next request would see a changed stat and re-read.
      const pending = pendingLoads.get(sessionId);
      if (pending) {
        stopwatch.note('cache', 'coalesced');
        return stopwatch.phase('loadCoalesced', () => pending);
      }

      // The reader is handed the `load` phase's own recorder, so everything it
      // times is recorded inside the load rather than beside it.
      const load = stopwatch.phase('load', (loadTiming) => loadFull(loadTiming)).then((full) => {
        entries.delete(sessionId);
        entries.set(sessionId, {
          transcriptPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          full,
        });
        evictOverBudget();
        return full;
      });
      pendingLoads.set(sessionId, load);
      try {
        return await load;
      } finally {
        pendingLoads.delete(sessionId);
      }
    },
  };
}

export const sessionHistoryCache = createSessionHistoryCache();
