import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPluginEnv } from '../plugin-process.service.js';

const pluginEnv = (): Record<string, string | undefined> => buildPluginEnv('demo');

test('plugin env carries CLAUDE_CONFIG_DIR when the server has one, and omits it otherwise', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = '/srv/claude-work';
    assert.equal(pluginEnv().CLAUDE_CONFIG_DIR, '/srv/claude-work');

    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal('CLAUDE_CONFIG_DIR' in pluginEnv(), false);
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
  }
});
