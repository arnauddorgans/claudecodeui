/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { AUTO_BG_WAIT_CEILING_MS, resolveSessionProcessClose } from '@/shared/session-process-close.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';
/**
 * One Claude CLI process per app session.
 *
 * Every turn used to spawn its own `claude --resume` and the process was held
 * open afterwards only when the turn had started background work, up to a
 * ceiling. The next turn then spawned a second process and closed the first
 * one's stdin behind it, which does not stop a CLI still busy with that work:
 * two processes resumed the same transcript and both appended to it. Here a
 * session never has more than one process: a turn that cannot reuse the live
 * one closes it, and waits for it to be gone, before starting another.
 *
 * Who closes the process is `SESSION_PROCESS_CLOSE`
 * (`shared/session-process-close.ts`). `auto` keeps what CloudCLI always
 * did: the process is let go at the turn's `result`, held only while
 * background work is outstanding, and replaced by the next turn. `manual`
 * takes every turn through the same process's prompt stream, and ends it only
 * when a client closes the session, when the server shuts down, or when a turn
 * needs options the CLI cannot take live (a rewind, a changed working
 * directory), in which case it is replaced in one step.
 */
/** @typedef {import('@/shared/types.js').SessionProcessSnapshot} SessionProcessSnapshot */
/** @typedef {import('@/shared/types.js').SessionProcessTask} SessionProcessTask */

const sessionProcesses = new Map();
const pendingToolApprovals = new Map();
// Told about every process that starts or ends for an app session.
const processListeners = new Set();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// How long a closing process gets to leave on its own — turn interrupted, stdin
// closed — before it is killed.
const CLOSE_GRACE_MS = parseInt(process.env.CLAUDE_CLOSE_GRACE_MS, 10) || 10000;
// Passed to the CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: how long it waits for
// its background agents once stdin closes. A `manual` process only gets there
// on close; an `auto` one at the end of every turn, as before.
const BG_WAIT_ON_CLOSE_MS = 5000;
// How long an abort waits for the interrupted turn's own `result` before handing
// the session back; a `result` after that reads as background work reporting in.
const ABORT_SETTLE_MS = 5000;

// Replaced by tests with a fake SDK.
let queryImplementation = query;

function setClaudeQueryImplementation(implementation) {
  queryImplementation = implementation || query;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions, resolvedEffort) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = {
    ...process.env,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(
      resolveSessionProcessClose() === 'manual' ? BG_WAIT_ON_CLOSE_MS : AUTO_BG_WAIT_CEILING_MS
    )
  };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * What a client is told about a session's process.
 * @param {Object} proc - Session process
 * @param {'chat'|'off'} state - Whether it is alive
 * @returns {SessionProcessSnapshot} Process snapshot
 */
function describeProcess(proc, state = 'chat') {
  return {
    sessionId: proc.key,
    provider: 'claude',
    state,
    since: proc.startedAt,
    providerSessionId: proc.providerSessionId,
    turnActive: Boolean(proc.turn),
    tasks: Array.from(proc.tasks.values())
  };
}

const ENDED_TASK_STATUSES = new Set(['completed', 'failed', 'stopped']);

/**
 * Keeps the process's record of a task up to date from one of the SDK's task
 * events, already normalized into a `task` message. The record outlives the
 * task so a client subscribing later still sees what ran, and it is what fills
 * the gaps in a `task_updated` frame, which only names what changed.
 * @param {Object} proc - Session process
 * @param {Object} msg - Normalized `task` message
 * @returns {{ task: SessionProcessTask, changed: boolean }} The record, and whether the task started or ended
 */
function recordTask(proc, msg) {
  let task = proc.tasks.get(msg.taskId);
  const isNew = !task;
  if (!task) {
    task = {
      taskId: msg.taskId,
      description: msg.description || '',
      background: false,
      status: 'started',
      startedAt: Date.now(),
    };
    proc.tasks.set(task.taskId, task);
  }

  const wasEnded = ENDED_TASK_STATUSES.has(task.status);
  for (const key of ['toolUseId', 'description', 'taskType', 'agentType', 'summary', 'usage']) {
    if (msg[key] !== undefined) {
      task[key] = msg[key];
    }
  }
  if (typeof msg.background === 'boolean') {
    task.background = msg.background;
  }
  // An ended task does not come back: a late progress frame is not a restart.
  if (msg.status && !(wasEnded && !ENDED_TASK_STATUSES.has(msg.status))) {
    task.status = msg.status;
  }
  const ended = !wasEnded && ENDED_TASK_STATUSES.has(task.status);
  if (ended) {
    task.endedAt = Date.now();
  }

  return { task, changed: isNew || ended };
}

/**
 * Stops one task of a session's process through the SDK's control channel.
 * The CLI answers with a `task_notification` of status `stopped`, which ends
 * the task's record like any other.
 * @param {string} sessionId - App session id
 * @param {string} taskId - Task id, as reported on the `task` frames
 * @returns {Promise<boolean>} False when the session has no live process or the task is not one of its
 */
async function stopClaudeSDKTask(sessionId, taskId) {
  const proc = sessionProcesses.get(sessionId);
  if (!proc || proc.closing || !proc.tasks.has(taskId)) {
    return false;
  }
  await proc.query.stopTask(taskId);
  return true;
}

function emitProcessChange(proc, state) {
  if (!proc.persistent || !proc.key) {
    return;
  }
  const snapshot = describeProcess(proc, state);
  for (const listener of processListeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('[Claude SDK] Session process listener failed:', error?.message || error);
    }
  }
}

/**
 * Registers a listener for processes starting and ending.
 * @param {(snapshot: SessionProcessSnapshot) => void} listener - Receives a process snapshot
 * @returns {() => void} Unsubscribes
 */
function onSessionProcessChange(listener) {
  processListeners.add(listener);
  return () => processListeners.delete(listener);
}

/**
 * The live process of an app session, if any.
 * @param {string} sessionId - App session id
 * @returns {SessionProcessSnapshot|null} Process snapshot
 */
function getSessionProcess(sessionId) {
  const proc = sessionProcesses.get(sessionId);
  return proc && proc.persistent && !proc.closing ? describeProcess(proc) : null;
}

/**
 * Every live session process.
 * @returns {Array<SessionProcessSnapshot>} Process snapshots
 */
function listSessionProcesses() {
  return Array.from(sessionProcesses.values())
    .filter((proc) => proc.persistent && !proc.closing)
    .map((proc) => describeProcess(proc));
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}


// Tool calls that leave work running past the end of a turn. Bash only counts
// when it is explicitly backgrounded; the rest defer or watch work by nature.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Under `auto` only turns that start background work hold their CLI
 * process open; every other turn lets it exit at its `result`.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
function startsBackgroundWork(sdkMessage) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * The prompt stream of a session's process: a turn's messages are pushed in
 * as they come, and the stream stays pending in between.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted
 * (and immediately on `result` for string prompts). The CLI reads that EOF as
 * the end of the run and kills anything still going in the background, so the
 * iterable only ends when the process is meant to go.
 *
 * @returns {{ stream: AsyncIterable, push: (message: Object) => boolean, end: () => void }}
 */
function createInputStream() {
  const queue = [];
  let ended = false;
  let wake = null;

  const stream = (async function* () {
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift();
      }
      if (ended) {
        return;
      }
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
  })();

  return {
    stream,
    push(message) {
      if (ended) {
        return false;
      }
      queue.push(message);
      wake?.();
      return true;
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      wake?.();
    }
  };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Runs one turn of a Claude session.
 *
 * A turn addressed to an app session goes to that session's process, started
 * here when there is none. Under `auto` a process still alive from the
 * previous turn (held for its background work) is closed first, as the next
 * turn always replaced it. Direct callers with no app session (the agent and
 * git routes, over SSE) get a process for this one turn, ended at its result.
 *
 * Resolves when the turn's `result` arrives, when the turn is aborted, or when
 * the process ends — never when the process merely stays alive afterwards.
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - Writer for this turn's events
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const closing = resolveSessionProcessClose();
  const persistent = Boolean(sessionId) && !ws?.isSSEStreamWriter && closing === 'manual';

  const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

  const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
  let effortModels = CLAUDE_PREDEFINED_MODELS;
  try {
    effortModels = await context.getProviderModels();
  } catch (error) {
    console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
  }
  const turnOptions = {
    ...options,
    providerSessionId,
    model: resolvedModel || options.model,
    effortModels,
  };

  let proc = sessionId ? sessionProcesses.get(sessionId) : undefined;
  if (proc && (proc.closing || !persistent || !canReuseProcess(proc, turnOptions))) {
    await closeSessionProcess(proc, 'replaced');
    proc = undefined;
  }

  if (proc) {
    await applyLiveOptions(proc, turnOptions);
  } else {
    proc = await launchSessionProcess({
      key: sessionId || null,
      turnOptions,
      persistent,
      context,
      sessionSummary,
      userId: ws?.userId ?? null,
      installedCheck: () => context.isProviderInstalled(),
    });
  }

  return runTurn(proc, promptMessages, ws, sessionSummary);
}

/**
 * Whether a live process can take a turn with these options. What the CLI
 * cannot change live means a new process: a rewind (`resumeSessionAt` reloads
 * a truncated transcript) and another working directory.
 * @param {Object} proc - Session process
 * @param {Object} turnOptions - This turn's options
 * @returns {boolean}
 */
function canReuseProcess(proc, turnOptions) {
  if (turnOptions.resumeAnchorId || turnOptions.resumeFromScratch) {
    return false;
  }
  return !turnOptions.cwd || !proc.cwd || turnOptions.cwd === proc.cwd;
}

/**
 * Applies a turn's options to a live process through the SDK's control
 * channel: model, permission mode and effort (the CLI's `/effort`, session-
 * scoped), plus the tool lists the approval gate reads. Entries remembered
 * through "always allow" during the process stay.
 * @param {Object} proc - Session process
 * @param {Object} turnOptions - This turn's options
 */
async function applyLiveOptions(proc, turnOptions) {
  const next = mapCliOptionsToSDK(turnOptions);
  const current = proc.sdkOptions;

  if (next.model !== current.model) {
    await proc.query.setModel(next.model);
    current.model = next.model;
  }

  const nextMode = next.permissionMode || 'default';
  if (nextMode !== (current.permissionMode || 'default')) {
    await proc.query.setPermissionMode(nextMode);
    current.permissionMode = next.permissionMode;
  }

  const nextUltracode = Boolean(next.settings?.ultracode);
  if ((next.effort ?? null) !== (current.effort ?? null) || nextUltracode !== Boolean(current.settings?.ultracode)) {
    await proc.query.applyFlagSettings({
      effortLevel: next.effort ?? null,
      ultracode: nextUltracode || null,
      enableWorkflows: nextUltracode || null,
    });
    current.effort = next.effort;
    current.settings = next.settings;
  }

  const allowed = new Set([...(next.allowedTools || []), ...proc.remembered]);
  current.allowedTools = Array.from(allowed);
  current.disallowedTools = (next.disallowedTools || []).filter((entry) => !proc.remembered.has(entry));
}

/**
 * Starts a session's process and its reader.
 * @param {Object} spec - Key, turn options, persistence, context, identity
 * @returns {Promise<Object>} Session process
 */
async function launchSessionProcess(spec) {
  const { turnOptions } = spec;
  const sdkOptions = mapCliOptionsToSDK(turnOptions);

  const mcpServers = await loadMcpConfig(turnOptions.cwd);
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
  }

  const proc = {
    key: spec.key,
    persistent: spec.persistent,
    // Provider-native id as the SDK reports it (starts as the resume id, or is
    // captured from the stream for brand-new sessions).
    providerSessionId: turnOptions.providerSessionId || null,
    resumed: Boolean(turnOptions.providerSessionId) && !turnOptions.resumeFromScratch,
    sessionCreatedSent: false,
    cwd: turnOptions.cwd || null,
    sdkOptions,
    remembered: new Set(),
    abortController: new AbortController(),
    input: null,
    query: null,
    // The writer of the latest turn: events between turns (background work
    // reporting in, a permission a background agent asks for) go there too.
    writer: null,
    userId: spec.userId,
    sessionSummary: spec.sessionSummary,
    context: spec.context,
    startedAt: Date.now(),
    // Every task the process ran, by task id (see `recordTask`).
    tasks: new Map(),
    turn: null,
    closing: false,
    exited: null,
    // `auto` only: the timer that lets a process held for background work go
    // after AUTO_BG_WAIT_CEILING_MS of silence.
    holdTimer: null,
  };

  sdkOptions.abortController = proc.abortController;

  sdkOptions.hooks = {
    Notification: [{
      matcher: '',
      hooks: [async (input) => {
        const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
        // Notifications are app-facing, so they carry the app session id.
        notifyUserIfEnabled({
          userId: proc.userId,
          writer: proc.writer,
          event: createNotificationEvent({
            provider: 'claude',
            sessionId: appSessionIdOf(proc),
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: proc.sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${appSessionIdOf(proc) || 'none'}:${message}`
          })
        });
        return {};
      }]
    }]
  };

  sdkOptions.canUseTool = createToolGate(proc);

  const start = () => {
    proc.input = createInputStream();
    proc.query = queryImplementation({
      prompt: proc.input.stream,
      options: sdkOptions
    });
  };

  try {
    start();
  } catch (hookError) {
    // Older/newer SDK versions may not accept hook shapes yet.
    // Keep notification behavior operational via runtime events even if hook registration fails.
    console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
    delete sdkOptions.hooks;
    proc.input.end();
    start();
  }

  if (proc.key) {
    sessionProcesses.set(proc.key, proc);
  }

  proc.exited = readProcess(proc).finally(() => {
    if (proc.key && sessionProcesses.get(proc.key) === proc) {
      sessionProcesses.delete(proc.key);
    }
    emitProcessChange(proc, 'off');
  });
  emitProcessChange(proc, 'chat');

  return proc;
}

function appSessionIdOf(proc) {
  return proc.key || proc.providerSessionId || null;
}

function eventSessionIdOf(proc) {
  return proc.providerSessionId || proc.key || null;
}

/**
 * The SDK's `canUseTool` for one process: settings first, then the client.
 *
 * Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
 * at the permission-mode step and skips this callback, so interactive tools
 * (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
 * auto-approves them and the model acts on a generated answer. Move these
 * tools to a PreToolUse hook (runs before the mode check) if we need them
 * to work in those modes.
 * @param {Object} proc - Session process
 * @returns {Function} canUseTool
 */
function createToolGate(proc) {
  return async (toolName, input, toolContext) => {
    const sdkOptions = proc.sdkOptions;
    const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

    if (!requiresInteraction) {
      if (sdkOptions.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input };
      }

      const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isDisallowed) {
        return { behavior: 'deny', message: 'Tool disallowed by settings' };
      }

      const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isAllowed) {
        return { behavior: 'allow', updatedInput: input };
      }
    }

    const writer = proc.writer;
    const requestId = createRequestId();
    writer?.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: eventSessionIdOf(proc), provider: 'claude' }));
    notifyUserIfEnabled({
      userId: proc.userId,
      writer,
      event: createNotificationEvent({
        provider: 'claude',
        sessionId: appSessionIdOf(proc),
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: proc.sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${appSessionIdOf(proc) || 'none'}:${requestId}`
      })
    });

    const decision = await waitForToolApproval(requestId, {
      timeoutMs: requiresInteraction ? 0 : undefined,
      signal: toolContext?.signal,
      metadata: {
        // Keyed by the app session id so `chat.subscribe` can look pending
        // approvals up directly; provider id only for legacy callers.
        _sessionId: appSessionIdOf(proc),
        _toolName: toolName,
        _input: input,
        _receivedAt: new Date(),
      },
      onCancel: (reason) => {
        writer?.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: eventSessionIdOf(proc), provider: 'claude' }));
      }
    });
    if (!decision) {
      return { behavior: 'deny', message: 'Permission request timed out' };
    }

    if (decision.cancelled) {
      return { behavior: 'deny', message: 'Permission request cancelled' };
    }

    // A client answered. Announce it on the run stream so the replay buffer
    // and every other attached tab drop the prompt — resolving happens over
    // the inbound socket only, so without this a mid-run page refresh
    // replays the `permission_request` with nothing to retract it and the
    // already-answered prompt resurrects.
    writer?.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: eventSessionIdOf(proc), provider: 'claude' }));

    if (decision.allow) {
      if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
        proc.remembered.add(decision.rememberEntry);
        if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
          sdkOptions.allowedTools.push(decision.rememberEntry);
        }
        if (Array.isArray(sdkOptions.disallowedTools)) {
          sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
        }
      }
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
    }

    return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
  };
}

/**
 * Pushes a turn into a process and waits for it to end.
 * @param {Object} proc - Session process
 * @param {Array<Object>} promptMessages - SDKUserMessage records for the turn
 * @param {Object} ws - Writer for this turn's events
 * @param {string} [sessionSummary] - Session name for notifications
 * @returns {Promise<void>}
 */
async function runTurn(proc, promptMessages, ws, sessionSummary) {
  const previous = proc.turn;
  if (previous) {
    // An aborted turn stays open until its own `result` lands, or the settle
    // window passes. A turn still going means a direct caller sent without
    // waiting (the gateway refuses that): the newer turn takes over.
    if (!previous.aborted) {
      await abortTurn(proc);
    }
    await previous.done;
  }

  proc.writer = ws;
  proc.userId = ws?.userId ?? proc.userId;
  proc.sessionSummary = sessionSummary ?? proc.sessionSummary;

  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  proc.turn = { done, finish, aborted: false, completeSent: false, assistantBudgetSent: false, backgroundWork: false };

  console.log('Turn started for session:', proc.key || proc.providerSessionId || 'NEW');
  for (const message of promptMessages) {
    proc.input.push(message);
  }

  return done;
}

/**
 * Reads a process's stream for its whole life and routes each message to the
 * turn it belongs to.
 * @param {Object} proc - Session process
 */
async function readProcess(proc) {
  console.log('Claude process started for session:', proc.key || proc.providerSessionId || 'NEW');
  try {
    for await (const message of proc.query) {
      if (message.session_id && !proc.providerSessionId) {
        captureProviderSessionId(proc, message.session_id);
      }
      handleProcessMessage(proc, message);
    }
    finishProcess(proc, null);
  } catch (error) {
    finishProcess(proc, error);
  }
}

function captureProviderSessionId(proc, providerSessionId) {
  proc.providerSessionId = providerSessionId;
  if (!proc.key) {
    // Legacy/direct callers gave no app session id: the provider id keys the
    // process so an abort can still find it.
    proc.key = providerSessionId;
    sessionProcesses.set(proc.key, proc);
  }

  const writer = proc.writer;
  if (writer?.setSessionId && typeof writer.setSessionId === 'function') {
    writer.setSessionId(providerSessionId);
  }

  // Sent once, for sessions that had nothing to resume.
  if (!proc.resumed && !proc.sessionCreatedSent) {
    proc.sessionCreatedSent = true;
    writer?.send(createNormalizedMessage({ kind: 'session_created', newSessionId: providerSessionId, sessionId: providerSessionId, provider: 'claude' }));
  }
}

function handleProcessMessage(proc, message) {
  const turn = proc.turn;
  const writer = proc.writer;
  const sid = eventSessionIdOf(proc);

  // Transform and normalize message via adapter
  const transformedMessage = transformMessage(message);
  const normalized = proc.context.normalizeMessage(transformedMessage, sid);
  let tasksChanged = false;
  for (const msg of normalized) {
    // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
    if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
      msg.parentToolUseId = transformedMessage.parentToolUseId;
    }
    if (isSubagentPromptEcho(msg)) {
      continue;
    }
    if (msg.kind === 'task') {
      // The frame goes out whole: what this event left unsaid, the record knows.
      const { task, changed } = recordTask(proc, msg);
      Object.assign(msg, task);
      tasksChanged = tasksChanged || changed;
    }
    writer?.send(msg);
  }
  if (tasksChanged) {
    emitProcessChange(proc, 'chat');
  }

  if (writer) {

    // Extract and send token budget updates from assistant usage payloads,
    // falling back to the turn's cumulative bill only for SDK builds that
    // report no per-assistant usage at all.
    const tokenBudgetData = extractTokenBudget(message)
      || (turn && !turn.assistantBudgetSent ? extractCumulativeTokenBudget(message) : null);
    if (tokenBudgetData) {
      if (message.type === 'assistant' && turn) {
        turn.assistantBudgetSent = true;
      }
      writer.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: sid, provider: 'claude' }));
    }
  }

  if (turn && startsBackgroundWork(message)) {
    turn.backgroundWork = true;
  }

  if (message.type !== 'result') {
    if (proc.holdTimer) {
      // Background activity after the turn: push the countdown back out.
      holdProcess(proc);
    }
    return;
  }

  const backgroundWork = Boolean(turn?.backgroundWork);
  if (turn) {
    endTurn(proc, turn, {});
  } else {
    // A result with no turn open is background work reporting back through a
    // follow-up turn the CLI ran on its own.
    notifyBackgroundWorkCompleted({
      userId: proc.userId,
      provider: 'claude',
      sessionId: appSessionIdOf(proc),
      sessionName: proc.sessionSummary
    });
  }

  if (proc.persistent) {
    return;
  }
  if (backgroundWork) {
    // `auto`: work started during this turn is still running. Hold the
    // process open so it can finish and report back; the ceiling is only a
    // backstop for work that never reports.
    holdProcess(proc);
  } else {
    // Either one turn was all this process was for, or the background work
    // just reported in: let the CLI exit now.
    clearHold(proc);
    proc.input.end();
  }
}

/**
 * `auto` only: arms (or re-arms) the countdown after which a process held
 * for background work is let go.
 * @param {Object} proc - Session process
 */
function holdProcess(proc) {
  clearHold(proc);
  proc.holdTimer = setTimeout(() => {
    proc.holdTimer = null;
    proc.input.end();
  }, AUTO_BG_WAIT_CEILING_MS);
  // Never let the hold keep the server process alive on its own.
  proc.holdTimer.unref?.();
}

function clearHold(proc) {
  if (proc.holdTimer) {
    clearTimeout(proc.holdTimer);
    proc.holdTimer = null;
  }
}

/**
 * Ends the open turn: the terminal `complete` for the client, unless the turn
 * was aborted (the abort handler sends that one), and the run notification.
 * @param {Object} proc - Session process
 * @param {Object} turn - The turn ending
 * @param {{ error?: Error, errorContent?: string, exitCode?: number }} outcome
 */
function endTurn(proc, turn, outcome) {
  if (proc.turn === turn) {
    proc.turn = null;
  }
  if (turn.completeSent) {
    turn.finish();
    return;
  }
  turn.completeSent = true;

  const writer = proc.writer;
  const sid = eventSessionIdOf(proc);
  const appSessionId = appSessionIdOf(proc);

  if (outcome.error) {
    writer?.send(createNormalizedMessage({ kind: 'error', content: outcome.errorContent || outcome.error.message, sessionId: sid, provider: 'claude' }));
    writer?.send(createCompleteMessage({ provider: 'claude', sessionId: sid, exitCode: 1 }));
    notifyRunFailed({
      userId: proc.userId,
      provider: 'claude',
      sessionId: appSessionId,
      sessionName: proc.sessionSummary,
      error: outcome.error
    });
  } else {
    if (!turn.aborted) {
      writer?.send(createCompleteMessage({ provider: 'claude', sessionId: sid, exitCode: outcome.exitCode ?? 0 }));
    }
    notifyRunStopped({
      userId: proc.userId,
      provider: 'claude',
      sessionId: appSessionId,
      sessionName: proc.sessionSummary,
      stopReason: turn.aborted ? 'aborted' : 'completed'
    });
  }

  turn.finish();
}

/**
 * The process's stream ended: settles the open turn, if any.
 * @param {Object} proc - Session process
 * @param {Error|null} error - What ended it, when it was not asked to
 */
function finishProcess(proc, error) {
  const turn = proc.turn;
  const label = proc.key || proc.providerSessionId || 'NEW';

  if (error && !proc.closing) {
    console.error(`Claude process for session ${label} failed:`, error);
  } else {
    console.log(`Claude process ended for session: ${label}`);
  }

  if (!turn) {
    return;
  }

  if (proc.closing) {
    // Closed under a turn: the close handler sends the terminal complete.
    turn.aborted = true;
    endTurn(proc, turn, {});
    return;
  }

  if (!error) {
    // Left without a result: the client still needs a terminal complete.
    endTurn(proc, turn, {});
    return;
  }

  // Check if Claude CLI is installed for a clearer error message
  Promise.resolve(proc.context.isProviderInstalled())
    .catch(() => true)
    .then((installed) => {
      endTurn(proc, turn, {
        error,
        errorContent: installed
          ? error.message
          : 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      });
    });
}

/**
 * Interrupts the open turn. The process stays.
 *
 * Returns as soon as the CLI took the interrupt, so the abort handler sends
 * its `complete { aborted: true }` while the run is still open. The turn
 * itself stays open until its own `result` lands, which keeps the next turn's
 * `result` from being taken for it, and is handed back after
 * `ABORT_SETTLE_MS` if none comes.
 * @param {Object} proc - Session process
 * @returns {Promise<boolean>} True when a turn was interrupted
 */
async function abortTurn(proc) {
  const turn = proc.turn;
  if (!turn) {
    return false;
  }
  if (turn.aborted) {
    return true;
  }

  // Mark before interrupting so the run loop knows not to emit its own
  // terminal complete (the abort handler sends the aborted one).
  turn.aborted = true;
  try {
    await proc.query.interrupt();
  } catch (error) {
    console.error(`Error interrupting turn for session ${proc.key}:`, error?.message || error);
    turn.aborted = false;
    return false;
  }

  void sleep(ABORT_SETTLE_MS).then(() => {
    if (proc.turn === turn) {
      console.warn(`Turn for session ${proc.key} gave no result after interrupt; handing the session back`);
      endTurn(proc, turn, {});
    }
  });
  return true;
}

/**
 * Ends a session's process: the open turn is interrupted, stdin closed, and
 * the CLI killed if it has not left within the grace period.
 * @param {Object} proc - Session process
 * @param {string} reason - For the log
 * @returns {Promise<void>} Settles once the process is gone
 */
async function closeSessionProcess(proc, reason) {
  if (proc.closing) {
    await proc.exited;
    return;
  }
  proc.closing = true;
  clearHold(proc);
  console.log(`Closing Claude process for session ${proc.key || proc.providerSessionId || 'NEW'} (${reason})`);

  if (proc.turn) {
    // The close handler sends the terminal complete, as an abort does.
    proc.turn.aborted = true;
    try {
      await proc.query.interrupt();
    } catch (error) {
      console.warn(`Interrupt while closing session ${proc.key} failed:`, error?.message || error);
    }
  }
  proc.input.end();

  const left = await Promise.race([proc.exited.then(() => true), sleep(CLOSE_GRACE_MS).then(() => false)]);
  if (!left) {
    console.warn(`Claude process for session ${proc.key} did not exit within ${CLOSE_GRACE_MS} ms; killing it`);
    proc.abortController.abort();
    await Promise.race([proc.exited, sleep(CLOSE_GRACE_MS)]);
  }
}

/**
 * Aborts the turn in progress for a session. Its process stays alive.
 * @param {string} sessionId - Session identifier
 * @returns {Promise<boolean>} True if a turn was aborted, false if none was found
 */
async function abortClaudeSDKSession(sessionId) {
  const proc = sessionProcesses.get(sessionId);
  if (!proc) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  console.log(`Aborting turn for session: ${sessionId}`);
  return abortTurn(proc);
}

/**
 * Ends a session's process on request.
 * @param {string} sessionId - Session identifier
 * @returns {Promise<boolean>} True if a process was closed, false if none was found
 */
async function closeClaudeSDKSession(sessionId) {
  const proc = sessionProcesses.get(sessionId);
  if (!proc || proc.closing) {
    return false;
  }
  await closeSessionProcess(proc, 'closed');
  return true;
}

/**
 * Ends every session process, for the server's shutdown.
 * @returns {Promise<void>}
 */
async function closeAllClaudeSDKSessions() {
  await Promise.all(
    Array.from(sessionProcesses.values()).map((proc) => closeSessionProcess(proc, 'shutdown'))
  );
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  close: closeClaudeSDKSession,
  stopTask: stopClaudeSDKTask,
  processes: {
    get: getSessionProcess,
    list: listSessionProcesses,
    onChange: onSessionProcessChange,
    closeAll: closeAllClaudeSDKSessions,
  },
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  closeClaudeSDKSession,
  closeAllClaudeSDKSessions,
  stopClaudeSDKTask,
  getSessionProcess,
  listSessionProcesses,
  onSessionProcessChange,
  resolveToolApproval,
  getPendingApprovalsForSession,
  extractTokenBudget,
  extractCumulativeTokenBudget,
  setClaudeQueryImplementation
};
