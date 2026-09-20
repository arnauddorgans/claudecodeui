import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';

import type { SessionHistoryTiming } from '@/shared/types.js';

/**
 * Where the seconds of a session history read go.
 *
 * `GET /sessions/:id/messages` is served through `sessionHistoryCache`, whose
 * miss path re-reads the whole transcript plus every subagent transcript the
 * session spawned. On the live server that miss has been measured at 54 s for
 * work an isolated harness does in about a second, and nothing in the logs said
 * which part was slow — or whether it was slow at all, as opposed to starved by
 * whatever else the process was doing at the time.
 *
 * So a request carries a recorder, and the recorder answers three questions.
 *
 * *Which phase?* Every phase is a real interval on the clock. A phase hands its
 * callback a recorder of its own, so a phase opened inside another is its child
 * by construction rather than by guessing from a stack — two phases of one
 * request can run at once (a `Promise.all`), and then a stack's top is not the
 * opener's parent. A phase's `SelfMs` is its own interval minus the *union* of
 * its children's, so concurrent children are counted once and self time can
 * never go negative; `unaccountedMs` is the request minus the union of its
 * depth-0 phases. `totalMs = rootMs + unaccountedMs` and `xMs >= xSelfMs` hold
 * by construction, whatever shape the reader runs in.
 *
 * *How big?* Counters carry the bytes, lines and files a phase touched, and
 * notes the one-word answers — which provider, whether the cache hit, and which
 * part of its key changed when it missed.
 *
 * *Working, or waiting?* A 50 ms sampler measures its own lateness and charges
 * each open recorder the part of it that request was alive for: a blocked loop
 * coalesces interval ticks instead of queueing them, so the one tick that
 * finally runs carries the whole block, and clipping it to the request keeps
 * `loopBlockedMs` from ever exceeding the request's own wall time. That sum
 * minus the request's own synchronous phases is `waitedMs` — wall time the
 * request spent with the loop held by something else. `monitorEventLoopDelay`
 * cannot answer that, because a histogram cannot be differenced across
 * overlapping request windows; it is used for what it is good at instead, the
 * high-resolution worst case over the busy period (`loopDelayMaxMs`), which the
 * sampler's own maximum understates because it is quantized by its period.
 *
 * `cpuMs` beside `totalMs` separates the two ways a request can be starved: a
 * request held off the loop by the process's own work still shows the process
 * burning CPU throughout, while one whose machine gave the process no CPU at
 * all shows a `cpuMs` far below its wall time. The second is not something the
 * server can fix by reading its transcript differently.
 *
 * What it costs, measured on this machine: 8 us for the six phases of a cache
 * hit, 160 us for the ~280 phases of a Claude miss with 65 subagents — 0.6 us
 * per phase, against a miss that takes at least a second. Per process, and only
 * while requests are in flight or have been in the last `PROBE_IDLE_MS`, one
 * 50 ms interval, one GC observer and one native delay histogram; a CPU profile
 * put `histogram.percentile()` at 69 % of the whole recorder, so only `max` is
 * read, which is a scalar the histogram already holds.
 *
 * It also cannot distort what it reports or outlive what it measures: `totalMs`
 * is stamped before the recorder's own closing hop, a request that will not be
 * reported does not take that hop at all, nothing is retained once the line is
 * printed, no array or object is ever put in a log field, and past
 * `MAX_CONCURRENT_RECORDERS` requests simply go unmeasured so a pile-up cannot
 * be made worse by measuring it. `CLOUDCLI_HISTORY_TIMING=off` removes even
 * that; the default prints only requests slower than
 * `CLOUDCLI_HISTORY_TIMING_MS` (250 ms), so warm cache hits stay silent.
 */

/** How often the event loop is probed while an instrumented request is open. */
const SAMPLE_INTERVAL_MS = 50;
const DEFAULT_SLOW_MS = 250;
/** Past this many open recorders, further requests are not instrumented at all. */
const MAX_CONCURRENT_RECORDERS = 64;
/**
 * How long the process probes stay up after the last request closes. Tearing a
 * `PerformanceObserver` and a delay histogram down and back up costs more than
 * either costs to leave running, and a burst of reads is many requests, not one.
 */
const PROBE_IDLE_MS = 5_000;
/**
 * Per request, the most phase intervals that are kept for the union arithmetic.
 * A Claude read of a session with 65 subagents opens about 300; a runaway
 * reader that opened millions would be told to stop counting rather than be
 * allowed to spend the request's memory on its own bookkeeping.
 */
const MAX_INTERVALS = 20_000;
const BYTES_PER_MB = 1024 * 1024;
const NS_PER_MS = 1e6;
/** Constant for the life of the process, so it is read once and not per request. */
const HEAP_LIMIT_MB = Math.round(v8.getHeapStatistics().heap_size_limit / BYTES_PER_MB);

type TimingMode = 'off' | 'slow' | 'all';

type Interval = { start: number; end: number };

type PhaseRecord = {
  /** Wall time between entering and leaving the phase, summed over its calls. */
  ms: number;
  calls: number;
  /** Per call, the wall time covered by at least one child phase; summed. */
  childMs: number;
};

type RecorderState = {
  sessionId: string;
  limit: number | null;
  offset: number;
  startedAt: number;
  /** Stamped when the books close, before the recorder's own closing hop. */
  endedAt: number;
  finished: boolean;
  cpuStart: NodeJS.CpuUsage;
  heapStartBytes: number;
  gcStartMs: number;
  gcStartCount: number;
  inFlightAtStart: number;
  inFlightPeak: number;
  /** Event-loop delay observed by the shared sampler while this request was open. */
  loopBlockedMs: number;
  loopBlockedMaxMs: number;
  loopSamples: number;
  /** Intervals of the phases that declared they held the loop throughout. */
  syncIntervals: Interval[];
  /** Intervals of the depth-0 phases, which are what the request splits into. */
  rootIntervals: Interval[];
  intervalBudget: number;
  phases: Map<string, PhaseRecord>;
  /** Hand-measured sub-spans, which never take part in the parent arithmetic. */
  spans: Map<string, { ms: number; calls: number }>;
  counters: Map<string, number>;
  notes: Map<string, string>;
};

export type SessionHistoryTimingFields = Record<string, string | number | boolean>;

export type SessionHistoryRead = {
  timing: SessionHistoryTiming;
  /**
   * Closes the recorder, logs one line when the mode asks for it, and returns
   * the fields — a harness can read them without parsing stdout. Calling it
   * twice is harmless: the second call returns the same books.
   */
  finish(extra?: SessionHistoryTimingFields): Promise<SessionHistoryTimingFields>;
};

const liveRecorders = new Set<RecorderState>();

let sampler: ReturnType<typeof setInterval> | null = null;
let samplerDueAt = 0;
let gcObserver: PerformanceObserver | null = null;
let gcTotalMs = 0;
let gcTotalCount = 0;
let loopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;
let probeIdleTimer: ReturnType<typeof setTimeout> | null = null;

function readMode(): TimingMode {
  const raw = process.env.CLOUDCLI_HISTORY_TIMING?.trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false') {
    return 'off';
  }
  if (raw === 'all' || raw === '1' || raw === 'true') {
    return 'all';
  }
  return 'slow';
}

function readSlowThresholdMs(): number {
  const raw = Number(process.env.CLOUDCLI_HISTORY_TIMING_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SLOW_MS;
}

/**
 * Wall time covered by at least one of `intervals`, clipped to `[from, to]`.
 *
 * Overlapping intervals are counted once, which is what makes a parent's self
 * time right when its children ran concurrently, and what keeps it from ever
 * being negative.
 */
function unionMs(intervals: Interval[], from: number, to: number): number {
  if (intervals.length === 0) {
    return 0;
  }
  const clipped = intervals
    .map((interval) => ({
      start: Math.max(interval.start, from),
      end: Math.min(interval.end, to),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  if (clipped.length === 0) {
    return 0;
  }

  let covered = 0;
  let runStart = clipped[0].start;
  let runEnd = clipped[0].end;
  for (let index = 1; index < clipped.length; index += 1) {
    const interval = clipped[index];
    if (interval.start > runEnd) {
      covered += runEnd - runStart;
      runStart = interval.start;
      runEnd = interval.end;
    } else if (interval.end > runEnd) {
      runEnd = interval.end;
    }
  }
  return covered + (runEnd - runStart);
}

/**
 * Records an interval, unless this request has already spent its budget — in
 * which case the books say so rather than growing without bound.
 */
function pushInterval(state: RecorderState, into: Interval[], interval: Interval): void {
  if (state.intervalBudget <= 0) {
    state.notes.set('timingTruncated', 'intervals');
    return;
  }
  state.intervalBudget -= 1;
  into.push(interval);
}

/**
 * Samples event-loop delay for every open recorder.
 *
 * A blocked loop coalesces interval ticks instead of queuing them, so one tick
 * after a 5 s block reports the whole 5 s — the sum stays right however badly
 * the loop is starved, which is the point of the measurement.
 */
function sampleEventLoop(): void {
  const now = performance.now();
  // The loop was unavailable from when this tick was due until it ran.
  const blockedFrom = samplerDueAt;
  samplerDueAt = now + SAMPLE_INTERVAL_MS;

  for (const recorder of liveRecorders) {
    recorder.loopSamples += 1;
    // Only the part of the block the request was alive for is its to carry: a
    // request that opened inside a 141 ms block did not wait 141 ms, and one
    // charged more than its own wall time is a number that does not add up.
    const blockedMs = now - Math.max(blockedFrom, recorder.startedAt);
    if (blockedMs <= 0) {
      continue;
    }
    recorder.loopBlockedMs += blockedMs;
    if (blockedMs > recorder.loopBlockedMaxMs) {
      recorder.loopBlockedMaxMs = blockedMs;
    }
  }
}

function startProcessProbes(): void {
  if (probeIdleTimer) {
    clearTimeout(probeIdleTimer);
    probeIdleTimer = null;
  }
  if (sampler) {
    return;
  }
  samplerDueAt = performance.now() + SAMPLE_INTERVAL_MS;
  sampler = setInterval(sampleEventLoop, SAMPLE_INTERVAL_MS);
  // A probe must never be the reason the process stays alive.
  sampler.unref?.();

  gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcTotalMs += entry.duration;
      gcTotalCount += 1;
    }
  });
  gcObserver.observe({ entryTypes: ['gc'] });

  // Reset per busy period: the histogram covers from the first request of this
  // pile-up to the last, which is the window a starved request lived in.
  loopDelay ??= monitorEventLoopDelay({ resolution: 10 });
  loopDelay.reset();
  loopDelay.enable();
}

/** Tears the probes down once the process has been quiet for a while. */
function stopProcessProbes(): void {
  if (liveRecorders.size > 0 || probeIdleTimer || !sampler) {
    return;
  }
  probeIdleTimer = setTimeout(() => {
    probeIdleTimer = null;
    if (liveRecorders.size > 0) {
      return;
    }
    if (sampler) {
      clearInterval(sampler);
      sampler = null;
    }
    if (gcObserver) {
      gcObserver.disconnect();
      gcObserver = null;
    }
    loopDelay?.disable();
  }, PROBE_IDLE_MS);
  // Idling probes must never be the reason the process stays alive.
  probeIdleTimer.unref?.();
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function phaseRecord(state: RecorderState, name: string): PhaseRecord {
  const existing = state.phases.get(name);
  if (existing) {
    return existing;
  }
  const created: PhaseRecord = { ms: 0, calls: 0, childMs: 0 };
  state.phases.set(name, created);
  return created;
}

/**
 * Builds the recorder a phase's callback is handed.
 *
 * `siblings` is the interval list this level reports into — the request's root
 * list at depth 0, the enclosing phase's child list below it. Parentage is
 * therefore the call tree the reader actually wrote, not whatever happened to
 * be open when a phase started.
 */
function createTiming(state: RecorderState, siblings: Interval[]): SessionHistoryTiming {
  function close(
    record: PhaseRecord,
    children: Interval[],
    startedAt: number,
    synchronous: boolean,
  ): void {
    const endedAt = performance.now();
    record.ms += endedAt - startedAt;
    record.calls += 1;
    record.childMs += unionMs(children, startedAt, endedAt);

    const interval: Interval = { start: startedAt, end: endedAt };
    pushInterval(state, siblings, interval);
    if (synchronous) {
      pushInterval(state, state.syncIntervals, interval);
    }
  }

  return {
    now: () => performance.now(),
    async phase(name, run) {
      const record = phaseRecord(state, name);
      const children: Interval[] = [];
      const startedAt = performance.now();
      try {
        return await run(createTiming(state, children));
      } finally {
        close(record, children, startedAt, false);
      }
    },
    phaseSync(name, run) {
      const record = phaseRecord(state, name);
      const children: Interval[] = [];
      const startedAt = performance.now();
      try {
        return run(createTiming(state, children));
      } finally {
        close(record, children, startedAt, true);
      }
    },
    addMs(name, ms) {
      const span = state.spans.get(name);
      if (span) {
        span.ms += ms;
        span.calls += 1;
        return;
      }
      state.spans.set(name, { ms, calls: 1 });
    },
    count(name, amount) {
      state.counters.set(name, (state.counters.get(name) ?? 0) + amount);
    },
    note(name, value) {
      state.notes.set(name, value);
    },
  };
}

/**
 * A recorder that measures nothing, so readers can call the same methods on
 * every path instead of guarding each one. `phase` forwards the promise it is
 * given; the only cost is the call itself.
 */
export const noSessionHistoryTiming: SessionHistoryTiming = {
  now: () => 0,
  phase: (_name, run) => run(noSessionHistoryTiming),
  phaseSync: (_name, run) => run(noSessionHistoryTiming),
  addMs: () => {},
  count: () => {},
  note: () => {},
};

function buildFields(state: RecorderState, extra: SessionHistoryTimingFields): SessionHistoryTimingFields {
  const totalMs = state.endedAt - state.startedAt;
  const cpu = process.cpuUsage(state.cpuStart);
  const memory = process.memoryUsage();
  const rootMs = unionMs(state.rootIntervals, state.startedAt, state.endedAt);
  const syncMs = unionMs(state.syncIntervals, state.startedAt, state.endedAt);

  const fields: SessionHistoryTimingFields = {
    sessionId: state.sessionId,
    limit: state.limit ?? -1,
    offset: state.offset,
    totalMs: round(totalMs),
  };

  for (const [name, phase] of state.phases) {
    fields[`${name}Ms`] = round(phase.ms);
    if (phase.calls > 1) {
      fields[`${name}Calls`] = phase.calls;
    }
    if (phase.childMs > 0) {
      // Never negative: a call's children are clipped to the call's own span.
      fields[`${name}SelfMs`] = round(phase.ms - phase.childMs);
    }
  }
  for (const [name, span] of state.spans) {
    // A hand-measured span sits inside some phase; it is reported beside the
    // phases rather than among them, and a name clash does not overwrite one.
    const key = state.phases.has(name) ? `${name}SpanMs` : `${name}Ms`;
    fields[key] = round(span.ms);
    if (span.calls > 1) {
      fields[`${name}SpanCalls`] = span.calls;
    }
  }
  // The identity the breakdown is meant to satisfy: depth-0 phases cover
  // `rootMs` of the request, and what none of them covers is named. The
  // remainder is taken between the rounded numbers, so the two that are printed
  // add up to the total that is printed rather than to a hundredth beside it.
  const roundedTotalMs = round(totalMs);
  const roundedRootMs = round(Math.min(rootMs, totalMs));
  fields.totalMs = roundedTotalMs;
  fields.rootMs = roundedRootMs;
  fields.unaccountedMs = round(Math.max(0, roundedTotalMs - roundedRootMs));

  for (const [name, value] of state.counters) {
    fields[name] = Math.round(value);
  }
  for (const [name, value] of state.notes) {
    fields[name] = value;
  }

  // The sampler sees the request's own synchronous work as blockage too, so
  // what it did not do itself is what it waited for.
  fields.loopBlockedMs = round(state.loopBlockedMs);
  fields.loopBlockedMaxMs = round(state.loopBlockedMaxMs);
  fields.loopSamples = state.loopSamples;
  fields.selfSyncMs = round(syncMs);
  fields.waitedMs = round(Math.max(0, state.loopBlockedMs - syncMs));
  // `max` is a scalar the histogram already holds; `mean` and `percentile()`
  // walk it, and a CPU profile put `percentile(99)` at 69 % of everything the
  // recorder spends. The worst case is the number that matters here anyway.
  fields.loopDelayMaxMs = round((loopDelay?.max ?? 0) / NS_PER_MS);
  fields.gcMs = round(gcTotalMs - state.gcStartMs);
  fields.gcCount = gcTotalCount - state.gcStartCount;
  fields.cpuMs = round((cpu.user + cpu.system) / 1000);
  fields.heapUsedMb = round(memory.heapUsed / BYTES_PER_MB);
  fields.heapDeltaMb = round((memory.heapUsed - state.heapStartBytes) / BYTES_PER_MB);
  fields.rssMb = round(memory.rss / BYTES_PER_MB);
  fields.heapLimitMb = HEAP_LIMIT_MB;
  fields.inFlightAtStart = state.inFlightAtStart;
  fields.inFlightPeak = state.inFlightPeak;

  return { ...fields, ...extra };
}

/**
 * Opens a recorder for one history request, or returns `null` when timing is
 * switched off or too many requests are already being measured.
 *
 * The caller must call `finish()` on every path, or the recorder stays in
 * flight and the process probes stay running.
 */
export function beginSessionHistoryRead(request: {
  sessionId: string;
  limit: number | null;
  offset: number;
}): SessionHistoryRead | null {
  const mode = readMode();
  if (mode === 'off' || liveRecorders.size >= MAX_CONCURRENT_RECORDERS) {
    return null;
  }

  const startedAt = performance.now();
  const state: RecorderState = {
    sessionId: request.sessionId,
    limit: request.limit,
    offset: request.offset,
    startedAt,
    endedAt: startedAt,
    finished: false,
    cpuStart: process.cpuUsage(),
    heapStartBytes: process.memoryUsage().heapUsed,
    gcStartMs: gcTotalMs,
    gcStartCount: gcTotalCount,
    inFlightAtStart: liveRecorders.size,
    inFlightPeak: liveRecorders.size + 1,
    loopBlockedMs: 0,
    loopBlockedMaxMs: 0,
    loopSamples: 0,
    syncIntervals: [],
    rootIntervals: [],
    intervalBudget: MAX_INTERVALS,
    phases: new Map(),
    spans: new Map(),
    counters: new Map(),
    notes: new Map(),
  };

  liveRecorders.add(state);
  for (const other of liveRecorders) {
    if (liveRecorders.size > other.inFlightPeak) {
      other.inFlightPeak = liveRecorders.size;
    }
  }
  startProcessProbes();

  const timing = createTiming(state, state.rootIntervals);
  let books: SessionHistoryTimingFields | null = null;

  return {
    timing,
    async finish(extra = {}) {
      if (state.finished) {
        return books ?? {};
      }
      // Stamped before the hop below, so a loop this request is queued behind
      // cannot be charged to the request as if it were its own work.
      state.endedAt = performance.now();
      state.finished = true;
      liveRecorders.delete(state);

      const report = mode === 'all'
        || (state.endedAt - state.startedAt) >= readSlowThresholdMs();
      if (report) {
        // GC entries are delivered on a later tick, so the observer is given
        // one turn of the loop before the books are closed. Only a request
        // that will be reported pays for that turn; a warm cache hit, which is
        // the common case and the one with no room to spare, does not.
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }

      books = buildFields(state, extra);
      stopProcessProbes();

      if (report) {
        console.log('session history read', books);
      }
      return books;
    },
  };
}
