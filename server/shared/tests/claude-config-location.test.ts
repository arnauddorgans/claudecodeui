import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { getClaudeConfigDirectory, getClaudeGlobalConfigPath } from '@/shared/utils.js';

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  }
});

test('without CLAUDE_CONFIG_DIR the CLI defaults apply: ~/.claude and ~/.claude.json', () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(getClaudeConfigDirectory(), path.join(os.homedir(), '.claude'));
  assert.equal(getClaudeGlobalConfigPath(), path.join(os.homedir(), '.claude.json'));
});

test('an absolute CLAUDE_CONFIG_DIR holds both the config directory and .claude.json', () => {
  const configDir = path.join(os.tmpdir(), 'claude-work');
  process.env.CLAUDE_CONFIG_DIR = `  ${configDir}  `;
  assert.equal(getClaudeConfigDirectory(), configDir);
  assert.equal(getClaudeGlobalConfigPath(), path.join(configDir, '.claude.json'));
});

test('a relative or blank CLAUDE_CONFIG_DIR is ignored', () => {
  for (const value of ['relative-dir', '   ']) {
    process.env.CLAUDE_CONFIG_DIR = value;
    assert.equal(getClaudeConfigDirectory(), path.join(os.homedir(), '.claude'));
    assert.equal(getClaudeGlobalConfigPath(), path.join(os.homedir(), '.claude.json'));
  }
});
