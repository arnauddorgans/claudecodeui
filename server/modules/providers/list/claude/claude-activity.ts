import { createNormalizedMessage } from '@/shared/utils.js';
import type { AnyRecord, NormalizedMessage, SessionProcessActivity } from '@/shared/types.js';

/**
 * What the model says about its own work while a turn runs, from three SDK
 * stream messages nothing else forwards. None of them is written to the CLI's
 * transcript, so they are live only.
 *
 * - `system`/`status` becomes a `status` frame with `text: "activity"`:
 *   `activity` is `compacting`, `requesting` or null (anything else reads as
 *   idle), plus `compactResult`/`compactError` on the frame that ends a
 *   compaction and `permissionMode` when the CLI states one. It is the only
 *   thing that tells a long compaction from silence.
 * - `system`/`thinking_tokens` becomes a `status` frame with
 *   `text: "thinking_tokens"` and the running total `thinkingTokens`, at most
 *   one a second (`CLAUDE_THINKING_TOKENS_INTERVAL_MS`); the first of a block
 *   always goes.
 * - `tool_use_summary` becomes a frame of its own kind: the model's sentence
 *   about the calls it has just made, and their ids.
 */

const ACTIVITY_STATUSES = new Set(['compacting', 'requesting']);

const THINKING_TOKENS_INTERVAL_MS = parseInt(process.env.CLAUDE_THINKING_TOKENS_INTERVAL_MS ?? '', 10) || 1000;

const readString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The activity frame one SDK message stands for, or null for any other message. */
export function readClaudeActivityFrame(raw: AnyRecord | null | undefined, sessionId: string | null): NormalizedMessage | null {
  if (!raw || raw.parent_tool_use_id) {
    return null;
  }
  if (raw.type === 'tool_use_summary') {
    const summary = readString(raw.summary);
    if (!summary) {
      return null;
    }
    const precedingToolUseIds = Array.isArray(raw.preceding_tool_use_ids)
      ? raw.preceding_tool_use_ids.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
      : [];
    return createNormalizedMessage({
      id: readString(raw.uuid),
      kind: 'tool_use_summary',
      summary,
      precedingToolUseIds,
      sessionId,
      provider: 'claude',
    });
  }
  if (raw.type !== 'system') {
    return null;
  }
  if (raw.subtype === 'status') {
    const fields: AnyRecord = {};
    if (raw.compact_result === 'success' || raw.compact_result === 'failed') fields.compactResult = raw.compact_result;
    if (readString(raw.compact_error)) fields.compactError = raw.compact_error;
    if (readString(raw.permissionMode)) fields.permissionMode = raw.permissionMode;
    return createNormalizedMessage({
      ...fields,
      id: readString(raw.uuid),
      kind: 'status',
      text: 'activity',
      activity: typeof raw.status === 'string' && ACTIVITY_STATUSES.has(raw.status) ? raw.status : null,
      sessionId,
      provider: 'claude',
    });
  }
  if (raw.subtype === 'thinking_tokens') {
    const estimated = Number(raw.estimated_tokens);
    if (!Number.isFinite(estimated) || estimated < 0) {
      return null;
    }
    return createNormalizedMessage({
      id: readString(raw.uuid),
      kind: 'status',
      text: 'thinking_tokens',
      thinkingTokens: Math.round(estimated),
      sessionId,
      provider: 'claude',
    });
  }
  return null;
}

/**
 * The latest of each activity frame of the turn under way: what a client
 * arriving mid-turn reads on the process record, since the frames themselves
 * are only replayed while a run is registered. Turn-scoped: `clear` at each
 * turn's start and end.
 */
export function createActivityRecorder() {
  let activity: SessionProcessActivity | undefined;
  let thinkingTokensSentAt = 0;

  return {
    /**
     * Records one activity frame. `forward` says whether it goes out (the
     * thinking-token throttle); `changed` whether what the CLI is doing
     * changed, which is worth announcing beyond the run's own sockets.
     */
    record(frame: NormalizedMessage): { forward: boolean; changed: boolean } {
      const current: SessionProcessActivity = activity ?? { status: null };
      activity = current;
      if (frame.kind === 'tool_use_summary') {
        current.summary = frame.summary;
        current.summaryToolUseIds = frame.precedingToolUseIds as string[];
        return { forward: true, changed: false };
      }
      if (frame.text === 'thinking_tokens') {
        const estimated = frame.thinkingTokens as number;
        const previous = current.thinkingTokens;
        current.thinkingTokens = estimated;
        const restarted = typeof previous !== 'number' || estimated <= previous;
        if (restarted || Date.now() - thinkingTokensSentAt >= THINKING_TOKENS_INTERVAL_MS) {
          thinkingTokensSentAt = Date.now();
          return { forward: true, changed: false };
        }
        return { forward: false, changed: false };
      }
      const previous = current.status;
      current.status = (frame.activity as SessionProcessActivity['status']) ?? null;
      if (frame.compactResult !== undefined) current.compactResult = frame.compactResult as SessionProcessActivity['compactResult'];
      if (frame.compactError !== undefined) current.compactError = frame.compactError as string;
      return { forward: true, changed: current.status !== previous };
    },

    snapshot(): SessionProcessActivity | undefined {
      return activity ? { ...activity } : undefined;
    },

    clear(): void {
      activity = undefined;
      thinkingTokensSentAt = 0;
    },
  };
}
