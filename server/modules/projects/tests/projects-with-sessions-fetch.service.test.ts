import assert from 'node:assert/strict';
import test from 'node:test';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import {
  connectedClients,
  forgetRealtimeClient,
  registerRealtimeClientId,
} from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

type FakeClient = RealtimeClientConnection & { frames: Array<Record<string, unknown>> };

function fakeClient(): FakeClient {
  const frames: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    frames,
    send: (data: string) => { frames.push(JSON.parse(data) as Record<string, unknown>); },
  } as unknown as FakeClient;
}

async function withTwoProjects(run: () => Promise<void>): Promise<void> {
  const originals = {
    getProjectPaths: projectsDb.getProjectPaths,
    getSessionsByProjectPathPage: sessionsDb.getSessionsByProjectPathPage,
    countSessionsByProjectPath: sessionsDb.countSessionsByProjectPath,
  };
  try {
    projectsDb.getProjectPaths = (() => [
      { project_id: 'p1', project_path: '/tmp/one', custom_project_name: 'One', isStarred: 0 },
      { project_id: 'p2', project_path: '/tmp/two', custom_project_name: 'Two', isStarred: 0 },
    ]) as typeof projectsDb.getProjectPaths;
    sessionsDb.getSessionsByProjectPathPage = (() => []) as typeof sessionsDb.getSessionsByProjectPathPage;
    sessionsDb.countSessionsByProjectPath = (() => 0) as typeof sessionsDb.countSessionsByProjectPath;
    await run();
  } finally {
    Object.assign(projectsDb, { getProjectPaths: originals.getProjectPaths });
    Object.assign(sessionsDb, {
      getSessionsByProjectPathPage: originals.getSessionsByProjectPathPage,
      countSessionsByProjectPath: originals.countSessionsByProjectPath,
    });
  }
}

test('loading_progress goes to the client that asked, and to no other', async () => {
  const asker = fakeClient();
  const bystander = fakeClient();
  connectedClients.add(asker);
  connectedClients.add(bystander);
  registerRealtimeClientId(asker, 'client-asker-1');
  registerRealtimeClientId(bystander, 'client-bystander-1');
  try {
    await withTwoProjects(async () => {
      const projects = await getProjectsWithSessions({ skipSynchronization: true, progressClientId: 'client-asker-1' });
      assert.equal(projects.length, 2);
    });
    assert.deepEqual(asker.frames.map((frame) => frame.phase), ['loading', 'loading', 'complete']);
    assert.ok(asker.frames.every((frame) => frame.kind === 'loading_progress'));
    assert.equal(bystander.frames.length, 0);
  } finally {
    for (const client of [asker, bystander]) {
      connectedClients.delete(client);
      forgetRealtimeClient(client);
    }
  }
});

test('a fetch that names no client sends no progress at all', async () => {
  const bystander = fakeClient();
  connectedClients.add(bystander);
  registerRealtimeClientId(bystander, 'client-bystander-2');
  try {
    await withTwoProjects(async () => {
      await getProjectsWithSessions({ skipSynchronization: true });
      await getProjectsWithSessions({ skipSynchronization: true, progressClientId: 'client-gone-0000' });
    });
    assert.equal(bystander.frames.length, 0);
  } finally {
    connectedClients.delete(bystander);
    forgetRealtimeClient(bystander);
  }
});

test('an abandoned fetch stops and says nothing', async () => {
  const asker = fakeClient();
  registerRealtimeClientId(asker, 'client-asker-3');
  const abandoned = new AbortController();
  abandoned.abort();
  try {
    await withTwoProjects(async () => {
      const projects = await getProjectsWithSessions({
        skipSynchronization: true,
        progressClientId: 'client-asker-3',
        signal: abandoned.signal,
      });
      assert.deepEqual(projects, []);
    });
    assert.equal(asker.frames.length, 0);
  } finally {
    forgetRealtimeClient(asker);
  }
});

test('a client that reconnects under the same id keeps its progress on the new socket', async () => {
  const first = fakeClient();
  const second = fakeClient();
  registerRealtimeClientId(first, 'client-reconnect');
  registerRealtimeClientId(second, 'client-reconnect');
  // The old socket's close arrives after the new one registered: it must not
  // unregister the new one.
  forgetRealtimeClient(first);
  try {
    await withTwoProjects(async () => {
      await getProjectsWithSessions({ skipSynchronization: true, progressClientId: 'client-reconnect' });
    });
    assert.equal(first.frames.length, 0);
    assert.equal(second.frames.length, 3);
  } finally {
    forgetRealtimeClient(second);
  }
});
