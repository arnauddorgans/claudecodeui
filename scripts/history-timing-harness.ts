/**
 * Exercises the real session-history read against real transcripts, under the
 * kinds of pressure a live server is under, and prints the per-phase timing the
 * route now records.
 *
 * Nothing here touches the running servers or the transcripts they read: the
 * specimen session's files and the sessions database are copied into a sandbox
 * first, and the copy is what the harness appends to, clones and re-reads.
 *
 *   npx tsx --tsconfig server/tsconfig.json scripts/history-timing-harness.ts \
 *     --session <appSessionId> --scenario <name>
 *
 * Scenarios: `single` and `repeat` (a cold miss, then hits), `concurrent` (N
 * clones of the session read at once, each paying its own miss), `appends` (a
 * writer invalidating the cache under the reader), `blocking` (bursts of
 * synchronous work on the same loop), `agents` (the sidebar's own read beside
 * the page read), `live` (all of those at once) and `overhead` (the same read
 * measured and unmeasured, alternating).
 *
 * The process heap limit is part of the experiment: the server runs on Node's
 * default, and a 165 MB transcript parses to roughly 300 MB of live objects, so
 * `NODE_OPTIONS=--max-old-space-size=…` changes the answer more than any flag
 * below does.
 *
 *   --concurrency N   how many reads are fired at once (concurrent)
 *   --append-ms N     how often a row is appended to the transcript (appends)
 *   --block-ms N      how long each competing CPU burst holds the loop (blocking)
 *   --block-every N   how often a burst starts (blocking)
 *   --iterations N    reads per scenario (overhead, repeat)
 *   --refresh         re-copy the specimen files even when the sandbox has them
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import Database from 'better-sqlite3';

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[name] = true;
      continue;
    }
    args[name] = next;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const scenario = String(args.scenario ?? 'single');
const sessionId = String(args.session ?? '834f61b5-b30f-4632-a586-7cded8c8ad7e');
const concurrency = Number(args.concurrency ?? 4);
const appendEveryMs = Number(args['append-ms'] ?? 250);
const blockMs = Number(args['block-ms'] ?? 40);
const blockEveryMs = Number(args['block-every'] ?? 50);
const iterations = Number(args.iterations ?? 3);

const sourceDatabasePath = process.env.HARNESS_SOURCE_DB
  ?? path.join(os.homedir(), '.cloudcli', 'auth.db');
const sandboxRoot = process.env.HARNESS_SANDBOX ?? path.join(os.tmpdir(), 'history-timing-harness');
const sandboxDatabasePath = path.join(sandboxRoot, 'auth.db');

/** Clone session ids, so N concurrent reads each pay their own cache miss. */
function cloneSessionId(index: number): string {
  return createHash('sha1').update(`${sessionId}:${index}`).digest('hex').slice(0, 36);
}

async function copyIfNeeded(from: string, to: string, refresh: boolean): Promise<void> {
  if (!refresh && fs.existsSync(to)) {
    return;
  }
  await fsp.cp(from, to, { recursive: true, force: true });
}

async function prepareSandbox(): Promise<{ transcriptPath: string; cloneIds: string[] }> {
  await fsp.mkdir(sandboxRoot, { recursive: true });

  // A consistent copy of a database another process is writing to.
  const source = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });
  const row = source
    .prepare('select session_id, provider, provider_session_id, jsonl_path, project_path, custom_name from sessions where session_id = ?')
    .get(sessionId) as {
      session_id: string;
      provider: string;
      provider_session_id: string;
      jsonl_path: string;
      project_path: string;
      custom_name: string | null;
    } | undefined;
  if (!row) {
    throw new Error(`Session ${sessionId} is not in ${sourceDatabasePath}`);
  }
  await source.backup(sandboxDatabasePath);
  source.close();

  const refresh = Boolean(args.refresh);
  const transcriptPath = path.join(sandboxRoot, path.basename(row.jsonl_path));
  const sidecarSource = row.jsonl_path.replace(/\.jsonl$/, '');
  const sidecarTarget = transcriptPath.replace(/\.jsonl$/, '');
  await copyIfNeeded(row.jsonl_path, transcriptPath, refresh);
  if (fs.existsSync(sidecarSource)) {
    await copyIfNeeded(sidecarSource, sidecarTarget, refresh);
  }

  const sandbox = new Database(sandboxDatabasePath);
  sandbox.prepare('update sessions set jsonl_path = ? where session_id = ?').run(transcriptPath, sessionId);
  const cloneIds: string[] = [];
  const insert = sandbox.prepare(
    `insert or replace into sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path)
     values (?, ?, ?, ?, ?, ?)`,
  );
  for (let index = 0; index < Math.max(concurrency, 1); index += 1) {
    const cloneId = cloneSessionId(index);
    insert.run(cloneId, row.provider, row.provider_session_id, `${row.custom_name ?? 'clone'}-${index}`, row.project_path, transcriptPath);
    cloneIds.push(cloneId);
  }
  sandbox.close();

  return { transcriptPath, cloneIds };
}

/** Appends a real row to the transcript copy, which is what invalidates the cache. */
async function appendOneRow(transcriptPath: string): Promise<number> {
  const handle = await fsp.open(transcriptPath, 'r');
  try {
    const { size } = await handle.stat();
    const window = Math.min(256 * 1024, size);
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, size - window);
    const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim().length > 0);
    const lastLine = lines[lines.length - 1] ?? '{"type":"user"}';
    await fsp.appendFile(transcriptPath, `${lastLine}\n`, 'utf8');
    return Buffer.byteLength(lastLine) + 1;
  } finally {
    await handle.close();
  }
}

function formatFields(label: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ label, ...fields }));
}

async function main(): Promise<void> {
  const { transcriptPath, cloneIds } = await prepareSandbox();
  process.env.DATABASE_PATH = sandboxDatabasePath;
  process.env.CLOUDCLI_HISTORY_TIMING = process.env.CLOUDCLI_HISTORY_TIMING ?? 'off';

  const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');
  const { beginSessionHistoryRead } = await import(
    '@/modules/providers/services/session-history-timing.service.js'
  );

  /** One read, measured and serialized the way the route serializes it. */
  async function readOnce(id: string, label: string): Promise<Record<string, unknown> | null> {
    const read = beginSessionHistoryRead({ sessionId: id, limit: 50, offset: 0 });
    const startedAt = performance.now();
    const result = await sessionsService.fetchHistory(id, { limit: 50, offset: 0, timing: read?.timing });
    if (!read) {
      formatFields(label, { totalMs: Math.round(performance.now() - startedAt), messages: result.messages.length });
      return null;
    }
    const payload = { success: true, data: result };
    const body = read.timing.phaseSync('serialize', () => JSON.stringify(payload));
    const fields = await read.finish({ responseBytes: body.length });
    formatFields(label, fields);
    return fields;
  }

  /**
   * One read of the specimen before anything is measured, so the numbers that
   * follow are about contention rather than a cold JIT or a cold page cache.
   */
  async function warmUp(): Promise<void> {
    const previousMode = process.env.CLOUDCLI_HISTORY_TIMING;
    process.env.CLOUDCLI_HISTORY_TIMING = 'off';
    const startedAt = performance.now();
    await sessionsService.fetchHistory(sessionId, { limit: 50, offset: 0 });
    process.env.CLOUDCLI_HISTORY_TIMING = previousMode;
    formatFields('warmup', { totalMs: Math.round(performance.now() - startedAt) });
  }

  if (scenario === 'single') {
    await readOnce(sessionId, 'cold-miss');
    return;
  }

  if (scenario === 'repeat') {
    for (let index = 0; index < iterations; index += 1) {
      await readOnce(sessionId, index === 0 ? 'cold-miss' : 'warm-hit');
    }
    return;
  }

  if (scenario === 'concurrent') {
    await warmUp();
    const ids = cloneIds.slice(0, concurrency);
    for (let round = 0; round < iterations; round += 1) {
      // One append invalidates every clone's entry: they key on the same file.
      await appendOneRow(transcriptPath);
      await Promise.all(ids.map((id, index) => readOnce(id, `round${round + 1}-read${index + 1}of${ids.length}`)));
    }
    return;
  }

  if (scenario === 'appends') {
    await warmUp();
    let appended = 0;
    const appender = setInterval(() => {
      void appendOneRow(transcriptPath).then(() => { appended += 1; });
    }, appendEveryMs);
    try {
      for (let index = 0; index < iterations; index += 1) {
        await readOnce(sessionId, `append-pressure-${index + 1}`);
      }
    } finally {
      clearInterval(appender);
    }
    console.log(JSON.stringify({ label: 'appends', appended }));
    return;
  }

  if (scenario === 'blocking') {
    await warmUp();
    // A stand-in for everything else the server does on this loop while a
    // history read runs: bursts of synchronous JSON work, the shape of a CLI
    // stream being parsed and fanned out over websockets.
    let bursts = 0;
    const sample = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(4096) } });
    const blocker = setInterval(() => {
      const until = performance.now() + blockMs;
      while (performance.now() < until) {
        JSON.parse(sample);
      }
      bursts += 1;
    }, blockEveryMs);
    try {
      for (let round = 0; round < iterations; round += 1) {
        await appendOneRow(transcriptPath);
        await readOnce(sessionId, `blocked-loop-${round + 1}`);
      }
    } finally {
      clearInterval(blocker);
    }
    console.log(JSON.stringify({ label: 'blocking', bursts, blockMs, blockEveryMs }));
    return;
  }

  if (scenario === 'agents') {
    // The other read the UI fires when a session is opened: every subagent
    // transcript the session spawned, counted turn by turn.
    await warmUp();
    await appendOneRow(transcriptPath);
    const agentsStartedAt = performance.now();
    const agents = sessionsService.listSessionAgents(sessionId);
    const read = readOnce(sessionId, 'with-agents-listing');
    const [listed] = await Promise.all([agents, read]);
    console.log(JSON.stringify({
      label: 'agents',
      agents: listed.length,
      agentsMs: Math.round(performance.now() - agentsStartedAt),
    }));
    return;
  }

  if (scenario === 'live') {
    // Everything a live server is doing while a user reopens a big session:
    // the CLI appending to the transcript, bursts of synchronous work on the
    // loop as its stream is parsed and fanned out, the sidebar's own read of
    // every subagent transcript, and N clients asking for the page.
    await warmUp();
    const sample = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(4096) } });
    let bursts = 0;
    let appended = 0;
    const blocker = setInterval(() => {
      const until = performance.now() + blockMs;
      while (performance.now() < until) {
        JSON.parse(sample);
      }
      bursts += 1;
    }, blockEveryMs);
    const appender = setInterval(() => {
      void appendOneRow(transcriptPath).then(() => { appended += 1; });
    }, appendEveryMs);

    try {
      const ids = cloneIds.slice(0, concurrency);
      for (let round = 0; round < iterations; round += 1) {
        await appendOneRow(transcriptPath);
        const agentsStartedAt = performance.now();
        const agents = sessionsService.listSessionAgents(sessionId).then((listed) => {
          formatFields(`round${round + 1}-agents`, {
            agents: listed.length,
            totalMs: Math.round(performance.now() - agentsStartedAt),
          });
        });
        await Promise.all([
          agents,
          ...ids.map((id, index) => readOnce(id, `round${round + 1}-read${index + 1}of${ids.length}`)),
        ]);
      }
    } finally {
      clearInterval(blocker);
      clearInterval(appender);
    }
    console.log(JSON.stringify({ label: 'live', bursts, appended, blockMs, blockEveryMs }));
    return;
  }

  if (scenario === 'overhead') {
    // The same read, measured and unmeasured, alternating so a cold page cache
    // or a growing heap lands on both.
    for (let index = 0; index < iterations; index += 1) {
      await appendOneRow(transcriptPath);
      process.env.CLOUDCLI_HISTORY_TIMING = 'all';
      await readOnce(sessionId, 'instrumented');
      await appendOneRow(transcriptPath);
      process.env.CLOUDCLI_HISTORY_TIMING = 'off';
      const startedAt = performance.now();
      await sessionsService.fetchHistory(sessionId, { limit: 50, offset: 0 });
      formatFields('uninstrumented', { totalMs: Math.round(performance.now() - startedAt) });
    }
    return;
  }

  throw new Error(`Unknown scenario "${scenario}"`);
}

await main();
process.exit(0);
