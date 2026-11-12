import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listBusyClaudeCliSessions } from '@/modules/providers/services/claude-cli-liveness.service.js';

test('reads the running-session registry under CLAUDE_CONFIG_DIR', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-liveness-test-'));
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    await mkdir(path.join(configDir, 'sessions'));
    // This test process stands in for a live `claude` that is mid-turn.
    await writeFile(
      path.join(configDir, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'session-in-custom-dir', status: 'busy', startedAt: 123 }),
    );

    process.env.CLAUDE_CONFIG_DIR = configDir;
    assert.deepEqual(await listBusyClaudeCliSessions(), [
      { providerSessionId: 'session-in-custom-dir', startedAt: 123 },
    ]);
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
  }
});
