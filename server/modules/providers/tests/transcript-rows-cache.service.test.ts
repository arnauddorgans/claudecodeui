import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTranscriptRowsCache } from '@/modules/providers/services/transcript-rows-cache.service.js';

const line = (row: Record<string, unknown>) => `${JSON.stringify(row)}\n`;

async function withTranscript(run: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rows-cache-'));
  try {
    await run(path.join(dir, 'session.jsonl'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('a transcript that grew is read from where the last read stopped', async () => {
  await withTranscript(async (file) => {
    const cache = createTranscriptRowsCache({ minFileBytes: 0 });
    await fs.writeFile(file, line({ sessionId: 's', uuid: 'a' }) + line({ sessionId: 'other', uuid: 'x' }));
    const counts: Record<string, number> = {};
    const notes: Record<string, string> = {};
    const timing = {
      count: (key: string, value: number) => { counts[key] = (counts[key] ?? 0) + value; },
      note: (key: string, value: string) => { notes[key] = value; },
    };

    const first = await cache.readRows({ filePath: file, sessionId: 's' });
    assert.deepEqual(first.map((row) => row.uuid), ['a']);

    const appended = line({ sessionId: 's', uuid: 'b' });
    await fs.appendFile(file, appended);
    const second = await cache.readRows({ filePath: file, sessionId: 's', timing: timing as never });
    assert.deepEqual(second.map((row) => row.uuid), ['a', 'b']);
    assert.equal(notes.rowsCache, 'append');
    assert.equal(counts.readBytes, Buffer.byteLength(appended));
    // The row objects are shared, the arrays are not.
    assert.equal(second[0], first[0]);
    assert.notEqual(second, first);

    const everything = await cache.readRows({ filePath: file, sessionId: null });
    assert.deepEqual(everything.map((row) => row.uuid), ['a', 'x', 'b']);
  });
});

test('a last line still being written is returned but not kept', async () => {
  await withTranscript(async (file) => {
    const cache = createTranscriptRowsCache({ minFileBytes: 0 });
    const whole = JSON.stringify({ sessionId: 's', uuid: 'c' });
    await fs.writeFile(file, line({ sessionId: 's', uuid: 'a' }) + whole.slice(0, 10));
    assert.deepEqual((await cache.readRows({ filePath: file, sessionId: 's' })).map((row) => row.uuid), ['a']);

    // Complete JSON, no newline yet: shown, and read again once the newline lands.
    await fs.writeFile(file, line({ sessionId: 's', uuid: 'a' }) + whole);
    assert.deepEqual((await cache.readRows({ filePath: file, sessionId: 's' })).map((row) => row.uuid), ['a', 'c']);
    await fs.appendFile(file, '\n' + line({ sessionId: 's', uuid: 'd' }));
    assert.deepEqual((await cache.readRows({ filePath: file, sessionId: 's' })).map((row) => row.uuid), ['a', 'c', 'd']);
  });
});

test('a transcript rewritten under the offset is read again from the start', async () => {
  await withTranscript(async (file) => {
    const cache = createTranscriptRowsCache({ minFileBytes: 0 });
    await fs.writeFile(file, line({ sessionId: 's', uuid: 'a' }) + line({ sessionId: 's', uuid: 'b' }));
    await cache.readRows({ filePath: file, sessionId: 's' });

    // Same length prefix changed, then grown: the guard bytes differ.
    await fs.writeFile(file, line({ sessionId: 's', uuid: 'A' }) + line({ sessionId: 's', uuid: 'B' }) + line({ sessionId: 's', uuid: 'C' }));
    assert.deepEqual((await cache.readRows({ filePath: file, sessionId: 's' })).map((row) => row.uuid), ['A', 'B', 'C']);

    // Shorter than what was consumed.
    await fs.writeFile(file, line({ sessionId: 's', uuid: 'z' }));
    assert.deepEqual((await cache.readRows({ filePath: file, sessionId: 's' })).map((row) => row.uuid), ['z']);
  });
});

test('concurrent reads of a growing file never duplicate rows', async () => {
  await withTranscript(async (file) => {
    const cache = createTranscriptRowsCache({ minFileBytes: 0 });
    await fs.writeFile(file, line({ sessionId: 's', uuid: 'a' }));
    await cache.readRows({ filePath: file, sessionId: 's' });
    await fs.appendFile(file, line({ sessionId: 's', uuid: 'b' }));
    const results = await Promise.all([1, 2, 3].map(() => cache.readRows({ filePath: file, sessionId: 's' })));
    for (const rows of results) {
      assert.deepEqual(rows.map((row) => row.uuid), ['a', 'b']);
    }
  });
});

test('files under the size floor are parsed each time and not retained', async () => {
  await withTranscript(async (file) => {
    const cache = createTranscriptRowsCache();
    await fs.writeFile(file, line({ sessionId: 's', uuid: 'a' }));
    await cache.readRows({ filePath: file, sessionId: 's' });
    assert.equal(cache.size(), 0);
  });
});
