import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session creation route names a CloudCLI session from the initial message', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        projectPath: workspacePath,
        initialMessage: 'abcd  efg\nhij klm nop',
      }),
    });
    const payload = await response.json() as {
      data: { sessionId: string; sessionName: string };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.data.sessionName, 'abcd efg hij klm');
    assert.equal(
      sessionsDb.getSessionById(payload.data.sessionId)?.custom_name,
      'abcd efg hij klm',
    );
  });
});

test('conversation search streams title matches before transcript results', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession(
      'title-only-session',
      'codex',
      workspacePath,
      'Release planning notes',
    );
    const transcriptPath = path.join(path.dirname(workspacePath), 'codex-search.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-12T09:00:00.000Z',
      payload: {
        type: 'user_message',
        kind: 'plain',
        message: 'Release planning also appears in this conversation.',
      },
    })}\n`);
    sessionsDb.createSession(
      'transcript-session',
      'codex',
      workspacePath,
      'Unrelated session',
      undefined,
      undefined,
      transcriptPath,
    );

    const response = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=release%20planning&limit=50`,
    );
    const eventStream = await response.text();
    const titleEventIndex = eventStream.indexOf('event: title-results');
    const conversationEventIndex = eventStream.indexOf('event: result');
    const doneEventIndex = eventStream.indexOf('event: done');

    assert.equal(response.status, 200);
    assert.ok(titleEventIndex >= 0);
    assert.ok(conversationEventIndex > titleEventIndex);
    assert.ok(doneEventIndex > titleEventIndex);

    const titleDataLine = eventStream
      .slice(titleEventIndex, conversationEventIndex)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(titleDataLine);

    const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
      titleResults: Array<{
        sessionId: string;
        sessionTitle: string;
        provider: string;
      }>;
    };
    assert.equal(titlePayload.titleResults.length, 1);
    assert.equal(titlePayload.titleResults[0]?.sessionId, 'title-only-session');
    assert.equal(titlePayload.titleResults[0]?.sessionTitle, 'Release planning notes');
    assert.equal(titlePayload.titleResults[0]?.provider, 'codex');
  });
});

test('reasoning effort is persisted and returned with the active session model', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('effort-session', 'codex', workspacePath);

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'ultra' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { effort: string; sessionId: string };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.effort, 'ultra');
    assert.equal(sessionsDb.getSessionById('effort-session')?.effort, 'ultra');

    const readResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-model`,
    );
    const readPayload = await readResponse.json() as {
      data: { effort: string | null; sessionId: string };
    };

    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.data.sessionId, 'effort-session');
    assert.equal(readPayload.data.effort, 'ultra');
  });
});

test('model routes expose immutable defaults and full custom model CRUD', async () => {
  await withProviderServer(async (baseUrl) => {
    const initialResponse = await fetch(`${baseUrl}/api/providers/codex/models`);
    const initialPayload = await initialResponse.json() as {
      data: {
        cache?: unknown;
        models: {
          OPTIONS: Array<{ recordId?: number; value: string; isCustom: boolean }>;
        };
      };
    };
    assert.equal(initialResponse.status, 200);
    assert.equal('cache' in initialPayload.data, false);
    const predefined = initialPayload.data.models.OPTIONS[0];
    assert.equal(predefined.isCustom, false);
    assert.equal(predefined.recordId, undefined);

    const createResponse = await fetch(`${baseUrl}/api/providers/codex/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Gateway GPT', id: 'gateway/gpt' }),
    });
    const createPayload = await createResponse.json() as {
      data: { model: { recordId: number; value: string; label: string; isCustom: boolean } };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.data.model.isCustom, true);
    const customRecordId = createPayload.data.model.recordId;

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Gateway GPT Updated', id: 'gateway/gpt-v2' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { model: { value: string; label: string } };
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.model.value, 'gateway/gpt-v2');
    assert.equal(updatePayload.data.model.label, 'Gateway GPT Updated');

    const immutableResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/999999`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Changed', id: 'changed' }),
      },
    );
    const immutablePayload = await immutableResponse.json() as { error: { code: string } };
    assert.equal(immutableResponse.status, 404);
    assert.equal(immutablePayload.error.code, 'MODEL_NOT_FOUND');

    const deleteResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      { method: 'DELETE' },
    );
    const deletePayload = await deleteResponse.json() as {
      data: { models: { OPTIONS: Array<{ recordId: number }> } };
    };
    assert.equal(deleteResponse.status, 200);
    assert.equal(
      deletePayload.data.models.OPTIONS.some((option) => option.recordId === customRecordId),
      false,
    );
  });
});

/**
 * The transcript pair current Claude versions write for one subagent: the
 * parent session next to `<session>/subagents/agent-<id>.jsonl` and its
 * sidecar metadata.
 */
async function writeClaudeSessionWithAgent(workspacePath: string, sessionId: string, agentId: string): Promise<string> {
  const parentPath = path.join(workspacePath, `${sessionId}.jsonl`);
  const subagentDirectory = path.join(workspacePath, sessionId, 'subagents');
  await mkdir(subagentDirectory, { recursive: true });
  await writeFile(parentPath, `${JSON.stringify({
    type: 'user', uuid: 'p-u1', sessionId, timestamp: '2026-09-01T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
  })}\n`, 'utf8');

  const agentRows = [
    {
      type: 'user', uuid: 'a-u1', isSidechain: true, agentId, sessionId, timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'List the files in this directory.' }] },
    },
    {
      type: 'assistant', uuid: 'a-a1', isSidechain: true, agentId, sessionId, timestamp: '2026-09-01T10:00:02.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } },
      ] },
    },
    {
      type: 'user', uuid: 'a-u2', isSidechain: true, agentId, sessionId, timestamp: '2026-09-01T10:00:03.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ls', content: 'a.txt\nb.txt' }] },
    },
    {
      type: 'assistant', uuid: 'a-a2', isSidechain: true, agentId, sessionId, timestamp: '2026-09-01T10:00:04.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Two files.' }] },
    },
  ];
  await writeFile(path.join(subagentDirectory, `agent-${agentId}.jsonl`), `${agentRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  await writeFile(
    path.join(subagentDirectory, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: 'Explore', description: 'List the files', toolUseId: 'toolu_agent', spawnDepth: 1 }),
    'utf8',
  );
  return parentPath;
}

test('agent routes list a session subagents and page one transcript like the session messages', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const sessionId = 'agents-session';
    const agentId = 'a1b2c3d4e5f60718';
    const parentPath = await writeClaudeSessionWithAgent(workspacePath, sessionId, agentId);
    const now = new Date().toISOString();
    sessionsDb.createSession(sessionId, 'claude', workspacePath, 'Agents session', now, now, parentPath);

    const list = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/agents`);
    assert.equal(list.status, 200);
    const { data: { agents } } = await list.json() as { data: { agents: Array<Record<string, unknown>> } };
    assert.equal(agents.length, 1);
    assert.equal(agents[0].agentId, agentId);
    assert.equal(agents[0].agentType, 'Explore');
    assert.equal(agents[0].description, 'List the files');
    assert.equal(agents[0].toolUseId, 'toolu_agent');
    assert.equal(agents[0].messageCount, 4);
    assert.equal(typeof agents[0].updatedAt, 'string');

    const all = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/agents/${agentId}/messages`);
    assert.equal(all.status, 200);
    const full = (await all.json() as { data: { messages: Array<Record<string, unknown>>; total: number; hasMore: boolean; offset: number; limit: number | null } }).data;
    assert.deepEqual(full.messages.map((message) => message.kind), ['text', 'text', 'tool_use', 'text']);
    assert.equal(full.total, 4);
    assert.equal(full.hasMore, false);
    assert.deepEqual([full.offset, full.limit], [0, null]);
    assert.ok(full.messages.every((message) => message.sessionId === sessionId), 'addressed by the app session id');
    const toolUse = full.messages.find((message) => message.kind === 'tool_use') as { toolResult?: { content?: string } };
    assert.equal(toolUse.toolResult?.content, 'a.txt\nb.txt', 'results are folded onto the call, as in /messages');

    const page = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/agents/${agentId}/messages?limit=2&offset=1`);
    const paged = (await page.json() as { data: { messages: Array<Record<string, unknown>>; total: number; hasMore: boolean } }).data;
    assert.deepEqual(paged.messages.map((message) => message.kind), ['text', 'tool_use'], 'offset walks back from the newest');
    assert.equal(paged.total, 4);
    assert.equal(paged.hasMore, true);

    const missing = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/agents/0000000000000000/messages`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, 'AGENT_NOT_FOUND');

    const invalid = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/agents/..%2Fescape/messages`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'INVALID_AGENT_ID');

    const unknownSession = await fetch(`${baseUrl}/api/providers/sessions/nope/agents`);
    assert.equal(unknownSession.status, 404);
  });
});
