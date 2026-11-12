import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * A long transcript's rows are kept between history reads (the rows cache
 * retains files of 4 MB and more), and a read after the file grew parses only
 * what was appended. The history built that way must be the one a fresh read
 * builds, the background-launch fold included.
 */

const SESSION_ID = 'claude-rows-cache-session';
const TOOL_USE_ID = 'toolu_agent_cache';
const AGENT_ID = 'agentcache0001';

test('a growing long transcript, read from where the last read stopped, folds the report that arrived since', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-rows-cache-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();

  try {
    const parentPath = path.join(tempRoot, `${SESSION_ID}.jsonl`);
    // Another session's rows push the file past the cache's size floor.
    const filler = JSON.stringify({ type: 'user', sessionId: 'someone-else', message: { role: 'user', content: 'x'.repeat(1000) } });
    const lines = Array.from({ length: 4500 }, () => filler);
    lines.push(
      JSON.stringify({
        type: 'assistant', uuid: 'a-1', sessionId: SESSION_ID, timestamp: '2026-08-21T10:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'Agent', input: { description: 'Survey', prompt: 'Look' } }] },
      }),
      JSON.stringify({
        type: 'user', uuid: 'ack-1', sessionId: SESSION_ID, timestamp: '2026-08-21T10:00:01.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'Async agent launched successfully.' }] },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT_ID, description: 'Survey' },
      }),
    );
    await writeFile(parentPath, `${lines.join('\n')}\n`, 'utf8');
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Cache session', now, now, parentPath);

    const read = async () => {
      const history = await new ClaudeSessionsProvider({ getLiveRunStartTime: () => null }).fetchHistory(SESSION_ID, { providerSessionId: SESSION_ID });
      return history.messages.find((message) => message.kind === 'tool_use' && message.toolId === TOOL_USE_ID);
    };

    const before = await read();
    assert.equal(before?.subagent?.status, 'stopped', 'no report and no live process');
    assert.equal(before?.toolResult?.content, '', 'the launch acknowledgement is hidden');

    // The report arrives: appended, so the next read parses only that row.
    await appendFile(parentPath, `${JSON.stringify({
      type: 'user', uuid: 'n-1', sessionId: SESSION_ID, timestamp: '2026-08-21T10:05:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: [
        '<task-notification>', `<task-id>${AGENT_ID}</task-id>`, `<tool-use-id>${TOOL_USE_ID}</tool-use-id>`,
        '<status>completed</status>', '<summary>done</summary>', '<result>Two packages.</result>', '</task-notification>',
      ].join('\n') }] },
    })}\n`, 'utf8');

    const after = await read();
    assert.equal(after?.subagent?.status, 'completed');
    assert.equal(after?.toolResult?.content, 'Two packages.');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
