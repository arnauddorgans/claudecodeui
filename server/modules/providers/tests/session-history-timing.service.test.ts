import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  beginSessionHistoryRead,
  noSessionHistoryTiming,
} from '@/modules/providers/services/session-history-timing.service.js';
import type { SessionHistoryTimingFields } from '@/modules/providers/services/session-history-timing.service.js';

/** Keeps the recorder from printing its line while the assertions run. */
function withQuietTiming<T>(mode: string, run: () => Promise<T>): Promise<T> {
  const previousMode = process.env.CLOUDCLI_HISTORY_TIMING;
  const previousThreshold = process.env.CLOUDCLI_HISTORY_TIMING_MS;
  process.env.CLOUDCLI_HISTORY_TIMING = mode;
  process.env.CLOUDCLI_HISTORY_TIMING_MS = '3600000';
  return run().finally(() => {
    if (previousMode === undefined) {
      delete process.env.CLOUDCLI_HISTORY_TIMING;
    } else {
      process.env.CLOUDCLI_HISTORY_TIMING = previousMode;
    }
    if (previousThreshold === undefined) {
      delete process.env.CLOUDCLI_HISTORY_TIMING_MS;
    } else {
      process.env.CLOUDCLI_HISTORY_TIMING_MS = previousThreshold;
    }
  });
}

function burnMs(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Holding the loop is the point: this is what a parse does.
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/** Every span a breakdown reports, and every derived one, is a real duration. */
function assertNoNegativeDurations(fields: SessionHistoryTimingFields): void {
  for (const [name, value] of Object.entries(fields)) {
    if (name.endsWith('Ms') && typeof value === 'number') {
      assert.ok(value >= 0, `${name} is ${value}, which is not a duration`);
    }
  }
}

test('a phase opened on the recorder it was handed is reported as part of it', async () => {
  await withQuietTiming('slow', async () => {
    const read = beginSessionHistoryRead({ sessionId: 'session', limit: 50, offset: 0 });
    assert.ok(read);

    await read.timing.phase('outer', async (outer) => {
      burnMs(20);
      outer.phaseSync('inner', () => burnMs(20));
    });
    const fields = await read.finish();

    const outerMs = Number(fields.outerMs);
    const innerMs = Number(fields.innerMs);
    assert.ok(outerMs >= innerMs, `outer ${outerMs} should contain inner ${innerMs}`);
    assert.ok(Math.abs(Number(fields.outerSelfMs) - (outerMs - innerMs)) < 1);
    assertNoNegativeDurations(fields);
  });
});

test('the breakdown adds up: the request is its depth-0 phases plus what none of them covered', async () => {
  await withQuietTiming('slow', async () => {
    const read = beginSessionHistoryRead({ sessionId: 'session', limit: 50, offset: 0 });
    assert.ok(read);

    await read.timing.phase('first', async () => { burnMs(15); });
    read.timing.phaseSync('second', () => burnMs(15));
    const fields = await read.finish();

    // The identity holds in the decimal that is printed, whatever shape the
    // phases ran in; the tolerance is there for binary floating point only.
    assert.ok(
      Math.abs(Number(fields.rootMs) + Number(fields.unaccountedMs) - Number(fields.totalMs)) < 0.05,
      `${String(fields.rootMs)} + ${String(fields.unaccountedMs)} != ${String(fields.totalMs)}`,
    );
    const accountedMs = Number(fields.firstMs) + Number(fields.secondMs) + Number(fields.unaccountedMs);
    assert.ok(
      Math.abs(accountedMs - Number(fields.totalMs)) < 2,
      `phases ${accountedMs} should account for total ${String(fields.totalMs)}`,
    );
    // Both phases held the loop, so both count as work the request did itself.
    assert.ok(Number(fields.selfSyncMs) >= 15);
    assertNoNegativeDurations(fields);
  });
});

test('two phases of one request that overlap stay siblings, and no self time goes negative', async () => {
  await withQuietTiming('slow', async () => {
    const read = beginSessionHistoryRead({ sessionId: 'session', limit: 50, offset: 0 });
    assert.ok(read);

    // The shape a stack of open phases gets wrong: `fast` closes while `slow`
    // is still open, so a stack would call `slow` a child of `fast` and charge
    // a 60 ms child to a 0 ms parent.
    await Promise.all([
      read.timing.phase('fast', async () => { await tick(); }),
      read.timing.phase('slow', async () => {
        await new Promise((resolve) => { setTimeout(resolve, 60); });
      }),
    ]);
    const fields = await read.finish();

    assert.equal(fields.fastSelfMs, undefined, 'fast has no children and must claim none');
    assert.equal(fields.slowSelfMs, undefined, 'slow has no children and must claim none');
    assert.ok(Number(fields.slowMs) >= 50);
    assert.ok(Number(fields.rootMs) <= Number(fields.totalMs));
    assertNoNegativeDurations(fields);
  });
});

test('children that run at once are counted once, not twice', async () => {
  await withQuietTiming('slow', async () => {
    const read = beginSessionHistoryRead({ sessionId: 'session', limit: 50, offset: 0 });
    assert.ok(read);

    await read.timing.phase('both', async (both) => {
      await Promise.all([
        both.phase('left', () => new Promise<void>((resolve) => { setTimeout(resolve, 60); })),
        both.phase('right', () => new Promise<void>((resolve) => { setTimeout(resolve, 60); })),
      ]);
    });
    const fields = await read.finish();

    const bothMs = Number(fields.bothMs);
    const sumOfChildren = Number(fields.leftMs) + Number(fields.rightMs);
    assert.ok(sumOfChildren > bothMs, 'the children really did overlap');
    // Summing them would make the parent owe more than it has; the union does not.
    assert.ok(
      Number(fields.bothSelfMs) >= 0 && Number(fields.bothSelfMs) < 25,
      `bothSelfMs ${String(fields.bothSelfMs)} should be the sliver neither child covered`,
    );
    assertNoNegativeDurations(fields);
  });
});

test('counters sum, notes keep the last answer, and both reach the fields', async () => {
  await withQuietTiming('slow', async () => {
    const read = beginSessionHistoryRead({ sessionId: 'session', limit: null, offset: 3 });
    assert.ok(read);

    read.timing.count('readBytes', 1000);
    await read.timing.phase('read', async (inner) => { inner.count('readBytes', 500); });
    read.timing.note('cache', 'miss');
    read.timing.note('cache', 'coalesced');
    const fields = await read.finish({ responseBytes: 42 });

    assert.equal(fields.readBytes, 1500);
    assert.equal(fields.cache, 'coalesced');
    assert.equal(fields.responseBytes, 42);
    assert.equal(fields.limit, -1);
    assert.equal(fields.offset, 3);
    // Log fields are flat scalars: an array or an object is dropped by the
    // log writer, which would silently lose whatever it carried.
    for (const value of Object.values(fields)) {
      assert.ok(!Array.isArray(value) && typeof value !== 'object');
    }
  });
});

test('a hand-measured span never overwrites the phase of the same name', async () => {
  await withQuietTiming('slow', async () => {
    const read = beginSessionHistoryRead({ sessionId: 'session', limit: 50, offset: 0 });
    assert.ok(read);

    await read.timing.phase('read', async (inner) => {
      burnMs(20);
      inner.addMs('read', 5);
      inner.addMs('readFirstLine', 2);
    });
    const fields = await read.finish();

    assert.ok(Number(fields.readMs) >= 20, 'the phase keeps its own name');
    assert.equal(fields.readSpanMs, 5);
    assert.equal(fields.readFirstLineMs, 2);
    assertNoNegativeDurations(fields);
  });
});

test('a request never carries more blocked loop than it has wall time', async () => {
  await withQuietTiming('slow', async () => {
    // A block that starts before the request does, and outlives its opening:
    // only the part the request was alive for is the request's to carry.
    setImmediate(() => burnMs(300));
    await new Promise((resolve) => { setImmediate(resolve); });
    const read = beginSessionHistoryRead({ sessionId: 'session', limit: 50, offset: 0 });
    assert.ok(read);
    await read.timing.phase('work', () => new Promise<void>((resolve) => { setTimeout(resolve, 120); }));
    const fields = await read.finish();

    assert.ok(
      Number(fields.loopBlockedMs) <= Number(fields.totalMs),
      `loopBlockedMs ${String(fields.loopBlockedMs)} exceeds totalMs ${String(fields.totalMs)}`,
    );
    assert.ok(Number(fields.waitedMs) <= Number(fields.totalMs));
    assertNoNegativeDurations(fields);
  });
});

test('a request is told how many of its kind were in flight with it', async () => {
  await withQuietTiming('slow', async () => {
    const first = beginSessionHistoryRead({ sessionId: 'a', limit: 50, offset: 0 });
    const second = beginSessionHistoryRead({ sessionId: 'b', limit: 50, offset: 0 });
    assert.ok(first && second);

    const firstFields = await first.finish();
    const secondFields = await second.finish();

    assert.equal(firstFields.inFlightAtStart, 0);
    assert.equal(firstFields.inFlightPeak, 2);
    assert.equal(secondFields.inFlightAtStart, 1);
    assert.equal(secondFields.inFlightPeak, 2);

    // Both slots came back, or a server would measure its way into a ceiling.
    const third = beginSessionHistoryRead({ sessionId: 'c', limit: 50, offset: 0 });
    assert.ok(third);
    assert.equal((await third.finish()).inFlightAtStart, 0);
  });
});

test('the recorder does not charge the request for its own closing hop', async () => {
  await withQuietTiming('slow', async () => {
    const read = beginSessionHistoryRead({ sessionId: 'session', limit: 50, offset: 0 });
    assert.ok(read);

    read.timing.phaseSync('work', () => burnMs(20));
    // Queued before `finish`, so the hop it waits on lands behind this block —
    // exactly what a contended loop does to it.
    setImmediate(() => burnMs(400));
    const fields = await read.finish();

    assert.ok(
      Number(fields.totalMs) < 200,
      `totalMs ${String(fields.totalMs)} was inflated by the recorder's own hop`,
    );
    assertNoNegativeDurations(fields);
  });
});

test('closing the books twice returns the same books', async () => {
  await withQuietTiming('slow', async () => {
    const read = beginSessionHistoryRead({ sessionId: 'session', limit: 50, offset: 0 });
    assert.ok(read);

    read.timing.phaseSync('work', () => burnMs(10));
    const first = await read.finish({ responseBytes: 7 });
    const second = await read.finish({ responseBytes: 99 });

    assert.equal(first.totalMs, second.totalMs);
    assert.equal(second.responseBytes, 7);
  });
});

test('timing switched off measures nothing at all', async () => {
  await withQuietTiming('off', async () => {
    assert.equal(beginSessionHistoryRead({ sessionId: 'session', limit: 50, offset: 0 }), null);
  });
});

test('the no-op recorder returns what it is given, and nests', async () => {
  assert.equal(
    await noSessionHistoryTiming.phase('read', async (inner) => inner.phaseSync('slice', () => 'rows')),
    'rows',
  );
  assert.equal(noSessionHistoryTiming.phaseSync('slice', () => 7), 7);
  assert.equal(noSessionHistoryTiming.now(), 0);
});
