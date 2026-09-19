# Providers Module Guide

This file documents the current provider contract in `server/modules/providers`.
Keep it current whenever provider wiring, skill discovery, or session sync
behavior changes. The goal is that a human or AI agent can add a new provider
without guessing which files need to move.

## Current Provider Shape

Every provider wrapper exposes seven facets:

- `runtime`
- `models`
- `auth`
- `mcp`
- `skills`
- `sessions`
- `sessionSynchronizer`

These correspond to the shared interfaces in `server/shared/interfaces.ts`:

- `IProviderRuntime`
- `IProviderModels`
- `IProviderAuth`
- `IProviderMcp`
- `IProviderSkills`
- `IProviderSessions`
- `IProviderSessionSynchronizer`

The services that consume them are:

- `providerModelsService`
- `providerAuthService`
- `providerMcpService`
- `providerSkillsService`
- `sessionsService`
- `sessionSynchronizerService`

Live execution is consumed through `providerRuntimeService`, which resolves the
provider-owned runtime through the same `providerRegistry` as every other facet.

Current provider ids in this repo are:

- `claude`
- `codex`
- `cursor`
- `opencode`

Those ids are mirrored in backend unions and frontend provider constants. If
adding a new provider, update every place that hardcodes this list.

## Current File Layout

Each provider lives under its own folder in `server/modules/providers/list/`:

```text
server/modules/providers/list/<provider>/
  <provider>.provider.ts
  <provider>-runtime.provider.js
  <provider>-auth.provider.ts
  <provider>-models.provider.ts
  <provider>-mcp.provider.ts
  <provider>-skills.provider.ts
  <provider>-sessions.provider.ts
  <provider>-session-synchronizer.provider.ts
```

The existing provider folders are `claude`, `codex`, `cursor`, and `opencode`.

Each provider wrapper owns its SDK/CLI runtime alongside its auth, model, and
session facets. Runtime adapters receive registry-backed model and session
lookups from `providerRuntimeService` at execution time instead of importing
those services themselves. This keeps `providerRegistry` as the only provider
mapping without creating a circular dependency. Application-level consumers
import the service from `server/modules/providers/index.ts`.

## What Each Facet Does

| Facet | Responsibility | Base / Service |
| --- | --- | --- |
| `runtime` | Run and abort live SDK/CLI sessions | `IProviderRuntime` -> `providerRuntimeService` |
| `models` | Resolve supported and active models | `IProviderModels` -> `providerModelsService` |
| `auth` | Report install/auth state for the provider runtime | `IProviderAuth` -> `providerAuthService` |
| `mcp` | Read, list, write, and remove provider-native MCP config | `McpProvider` -> `providerMcpService` |
| `skills` | Discover provider-native skill markdown files | `SkillsProvider` -> `providerSkillsService` |
| `sessions` | Normalize live events and fetch session history | `IProviderSessions` -> `sessionsService` |
| `sessionSynchronizer` | Scan transcript artifacts and upsert session metadata | `IProviderSessionSynchronizer` -> `sessionSynchronizerService` |

`sessions` and `sessionSynchronizer` are separate concerns:

- `sessions` handles runtime event normalization and history fetches.
- `sessionSynchronizer` handles file-backed session indexing into `sessionsDb`.

## How To Add A Provider

1. Add the provider id everywhere it is part of the contract.

- Update `server/shared/types.ts` `LLMProvider`.
- Update `src/types/app.ts` `LLMProvider` if the frontend should know about it.
- Update `server/modules/providers/provider.routes.ts`.
- Update `server/modules/agent/agent.routes.ts` if the provider is launchable from the agent runtime.
- Update `server/index.ts` if the provider needs runtime boot or shutdown wiring.
- Update the `PROVIDER_ORDER` list in `public/api-docs.html` if the provider should appear in the public API docs.
- Update `src/components/chat/hooks/useChatProviderState.ts` and
  `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx` if
  the provider should be selectable in chat.
- Update `src/components/provider-auth/view/ProviderLoginModal.tsx` if the
  provider has a login/setup flow.

2. Create the wrapper class.

- Add `server/modules/providers/list/<provider>/<provider>.provider.ts`.
- Add `server/modules/providers/list/<provider>/<provider>-runtime.provider.js`
  when the provider supports live SDK/CLI execution.
- Extend `AbstractProvider`.
- Expose readonly `auth`, `mcp`, `skills`, `sessions`, and `sessionSynchronizer`.
- Call `super('<provider>')`.

3. Implement auth.

- Return a full `ProviderAuthStatus`.
- Treat normal `not installed` / `not authenticated` states as data, not exceptions.
- Keep provider-specific credential discovery inside the auth provider.
- If the provider has no auth step, return a stable unauthenticated or not-installed status instead of omitting the facet.

4. Implement MCP.

- Extend `McpProvider`.
- Pass the supported scopes and transports to `super(...)`.
- Implement the four required methods:
  - `readScopedServers(...)`
  - `writeScopedServers(...)`
  - `buildServerConfig(...)`
  - `normalizeServerConfig(...)`
- Use the shared validation and normalization behavior from `McpProvider`.
- Keep the provider-specific config format local to the provider implementation.

Current MCP formats in this repo are:

| Provider | User / Project Storage | Supported Scopes | Supported Transports |
| --- | --- | --- | --- |
| Claude | `.mcp.json` in user / local / project locations | `user`, `local`, `project` | `stdio`, `http`, `sse` |
| Codex | `.codex/config.toml` | `user`, `project` | `stdio`, `http` |
| Cursor | `.cursor/mcp.json` | `user`, `project` | `stdio`, `http` |
| OpenCode | `~/.config/opencode/opencode.json` or `<workspace>/opencode.json` (`.jsonc` is read when present) | `user`, `project` | `stdio`, `http` |

5. Implement skills.

- Extend `SkillsProvider`.
- Implement `getSkillSources(workspacePath)`.
- Return the actual discovery roots for the provider.
- Skills are discovered from `SKILL.md` files.
- `readProviderSkillMarkdownDefinition(...)` reads front matter `name` and `description`.
- If `name` is missing, the parent directory name is used as a fallback.
- Use `recursive: true` only when the provider stores skills in nested trees.
- Keep the emitted `command` string aligned with the provider's real skill syntax.

Current skill discovery roots are:

| Provider | User Roots | Project / Repo Roots | Prefix | Notes |
| --- | --- | --- | --- | --- |
| Claude | `~/.claude/skills` | `<workspace>/.claude/skills` | `/` | Also discovers Claude plugin skills from enabled plugin installs. Command skills live under `commands/`; markdown skills live under `skills/` and are scanned recursively. |
| Codex | `~/.agents/skills`, `~/.codex/skills/.system`, `/etc/codex/skills` | `<workspace>/.agents/skills`, `path.dirname(workspacePath)/.agents/skills`, topmost git root `.agents/skills` | `$` | Overlapping roots are deduplicated before scanning. |
| Cursor | `~/.cursor/skills` | `<workspace>/.cursor/skills`, `<workspace>/.agents/skills` | `/` | Uses slash-style commands. |
| OpenCode | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills` | Cwd-to-topmost-git-root `.opencode/skills`, `.claude/skills`, and `.agents/skills` | `/` | Reuses OpenCode, Claude, and Agents skill locations. Overlapping roots are deduplicated before scanning. |

Command forms currently used by the providers are:

- Claude user/project skills: `/skill-name`
- Claude plugin skills: `/plugin-name:skill-name`
- Codex skills: `$skill-name`
- Cursor skills: `/skill-name`
- OpenCode skills: `/skill-name`

6. Implement sessions.

- Implement `normalizeMessage(raw, sessionId)` and `fetchHistory(sessionId, options)`.
- Use `createNormalizedMessage(...)` and `generateMessageId(...)` for emitted messages.
- Keep normalized message ids unique. If one raw event produces multiple text
  parts, append a discriminator so ids do not collide.
- Keep pagination consistent:
  - `limit: null` means unbounded/full history.
  - `limit: 0` means an empty page.
  - always return `total`, `hasMore`, `offset`, and `limit` when paginating.
- Sanitize any filesystem-derived ids before using them in file or database paths.
- Do not assume a provider's history format matches another provider's format.

7. Implement session synchronization.

- Implement `synchronize(since?: Date)` to scan provider artifacts and upsert
  sessions into `sessionsDb`.
- Implement `synchronizeFile(filePath)` for single-file watcher updates.
- Use the existing helpers when they fit:
  - `buildLookupMap(...)`
  - `extractFirstValidJsonlData(...)`
  - `findFilesRecursivelyCreatedAfter(...)`
  - `normalizeSessionName(...)`
  - `readFileTimestamps(...)`
- Make the sync resilient to partial, malformed, or missing provider files.
- The orchestration service runs all provider synchronizers and only advances
  `scan_state.last_scanned_at` when every provider succeeds.

Current session sync roots are:

| Provider | Scan Roots | Metadata Helpers / Notes |
| --- | --- | --- |
| Claude | `~/.claude/projects/**/*.jsonl` | Uses `~/.claude/history.jsonl` for name lookup and the trailing `ai-title`, `last-prompt`, or `custom-title` entries for title recovery. |
| Codex | `~/.codex/sessions/**/*.jsonl` | Uses `~/.codex/session_index.jsonl` for title lookup and the last `task_complete` message for a fallback title. |
| Cursor | `~/.cursor/projects/**/*.jsonl` | Uses sibling `worker.log` to recover `workspacePath`, then derives the session title from the first user prompt. |
| OpenCode | `~/.local/share/opencode/opencode.db` | Reads active sessions/messages/parts from OpenCode's shared SQLite database and stores `jsonl_path` as `null` so deleting one app session cannot remove the shared DB. |

8. Register the provider.

- Add the new provider class to `server/modules/providers/provider.registry.ts`.
- Update `server/modules/providers/provider.routes.ts` provider parsing.
- If the provider introduces a new service or lifecycle hook, export it from the module entrypoint that consumes providers.

9. Wire runtime and UI surfaces outside the providers module when needed.

If the provider can run live chat sessions, update the runtime entrypoints too:

- `server/modules/providers/list/<provider>/<provider>-runtime.provider.js`
- `server/modules/providers/list/<provider>/<provider>.provider.ts`
- `server/modules/agent/agent.routes.ts`
- `server/index.ts`

If the provider is visible in the UI, update:

- provider model fallback files under `server/modules/providers/list/<provider>/`
- `src/components/chat/hooks/useChatProviderState.ts`
- `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`
- `src/components/provider-auth/view/ProviderLoginModal.tsx`
- `src/components/mcp/constants.ts`

## Minimal Wrapper Template

```ts
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { <Provider>ProviderAuth } from './<provider>-auth.provider.js';
import { <Provider>ProviderModels } from './<provider>-models.provider.js';
import { <Provider>McpProvider } from './<provider>-mcp.provider.js';
import { <provider>Runtime } from './<provider>-runtime.provider.js';
import { <Provider>SkillsProvider } from './<provider>-skills.provider.js';
import { <Provider>SessionsProvider } from './<provider>-sessions.provider.js';
import { <Provider>SessionSynchronizer } from './<provider>-session-synchronizer.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

export class <Provider>Provider extends AbstractProvider {
  readonly runtime: IProviderRuntime = <provider>Runtime;
  readonly models: IProviderModels = new <Provider>ProviderModels();
  readonly auth: IProviderAuth = new <Provider>ProviderAuth();
  readonly mcp: IProviderMcp = new <Provider>McpProvider();
  readonly skills: IProviderSkills = new <Provider>SkillsProvider();
  readonly sessions: IProviderSessions = new <Provider>SessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer =
    new <Provider>SessionSynchronizer();

  constructor() {
    super('<provider>');
  }
}
```

## Minimal Skills Template

```ts
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

export class <Provider>SkillsProvider extends SkillsProvider {
  constructor() {
    super('<provider>');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.<provider>', 'skills'),
        commandPrefix: '/',
      },
    ];
  }
}
```

## Minimal Session Sync Template

```ts
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

export class <Provider>SessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    return null;
  }
}
```

## AI Prompt Template

Use this prompt when asking an AI agent to add a provider:

```text
Add a new provider "<provider>" using the current provider module architecture.

Requirements:
1) Create:
    - server/modules/providers/list/<provider>/<provider>.provider.ts
    - server/modules/providers/list/<provider>/<provider>-runtime.provider.js
   - server/modules/providers/list/<provider>/<provider>-auth.provider.ts
   - server/modules/providers/list/<provider>/<provider>-models.provider.ts
   - server/modules/providers/list/<provider>/<provider>-mcp.provider.ts
   - server/modules/providers/list/<provider>/<provider>-skills.provider.ts
   - server/modules/providers/list/<provider>/<provider>-sessions.provider.ts
   - server/modules/providers/list/<provider>/<provider>-session-synchronizer.provider.ts
2) Register in:
    - server/modules/providers/provider.registry.ts
    - server/modules/providers/provider.routes.ts
   - server/shared/types.ts LLMProvider
   - src/types/app.ts LLMProvider
3) Mirror the nearest existing provider implementation for file naming, style,
   and error handling.
4) Implement skills support with SkillsProvider and the current skill roots.
5) Implement session synchronization if the provider stores transcript files.
6) Ensure sessions use unique ids, safe path handling, and correct pagination.
7) Keep `sessions` and `sessionSynchronizer` separate.
8) Run:
   - npx eslint <touched files>
   - npx tsc --noEmit -p server/tsconfig.json
```

## Validation

After adding or changing a provider, run the relevant checks:

```bash
npx eslint server/modules/providers/**/*.ts server/shared/types.ts server/shared/interfaces.ts
npx tsc --noEmit -p server/tsconfig.json
```

Useful tests in this repo:

- `server/modules/providers/tests/mcp.test.ts`
- `server/modules/providers/tests/skills.test.ts`
- `server/modules/providers/tests/opencode-sessions.test.ts`
- `server/modules/providers/tests/claude-session-process.test.ts` (the process, its tasks, `stopTask`)
- `server/modules/providers/tests/claude-task-events.test.ts` (the SDK's task events as `task` messages)
- `server/modules/providers/tests/claude-activity.test.ts` (what the model says it is doing: summaries, status, thinking estimate)

If you touch sessions or session synchronization, add or update focused tests
alongside the implementation.

## Common Mistakes

- Adding provider files but forgetting `provider.registry.ts` or
  `provider.routes.ts`.
- Adding a live runtime without exposing it from the provider wrapper.
- Updating backend provider ids but not `src/types/app.ts` or the frontend
  provider constants.
- Omitting `runtime`, `skills`, or `sessionSynchronizer` from the wrapper.
- Returning duplicate normalized message ids for split content.
- Treating `limit === 0` as unbounded history.
- Building file paths from raw session ids without validation.
- Hardcoding a skill root without checking the provider's actual discovery rules.
- Forgetting that Claude plugin skills are discovered differently from normal
  user/project skill folders.
- Assuming one provider's MCP config file format works for the others.

## Claude: one process per session

`list/claude/claude-runtime.provider.js` keeps one Claude CLI process per app session, across turns.
Every turn used to spawn its own `claude --resume`, and since the background-work hold the next turn
spawned a second process and closed the first one's stdin behind it, which does not stop a CLI still
busy with that work: two processes resumed the same transcript and both appended to it.

- The first turn of a session starts the process (with `--resume` when the session row has a
  provider id); every following turn is pushed into its prompt stream. `run()` resolves at the
  turn's `result`, not when the process ends.
- `abort()` interrupts the turn and keeps the process. `close()` ends it: turn interrupted, stdin
  closed, and the CLI killed after `CLAUDE_CLOSE_GRACE_MS` (10 s) if it has not left.
- Model, permission mode and effort change on the live process through the SDK's control channel
  (`setModel`, `setPermissionMode`, `applyFlagSettings({ effortLevel })`). A turn that edits a sent
  message (`resumeSessionAt`) or changes the working directory replaces the process in one step: the
  old one is closed before the new one starts.
- `processes` exposes the live processes (`get`, `list`, `onChange`, `closeAll`); the websocket
  gateway broadcasts every change as `session_process`, and the server closes them all on shutdown.
  The gateway merges them with the terminals of `/shell` (`session-process-registry.service.ts`): a
  session is in the chat or in a terminal, never both; under `manual` a terminal resuming a session
  closes its chat process first.
- Callers with no app session (the agent and git routes, over SSE) get a process for one turn,
  ended at its `result`.
- **`SESSION_PROCESS_CLOSE`** (`shared/session-process-close.ts`) says who closes a session's process,
  for the chat process and the terminal's PTY alike. `auto`, the default, keeps what CloudCLI always did: a
  process per turn, held after its `result` only while background work is outstanding (a backgrounded
  `Bash`, `Monitor`, `ScheduleWakeup`, `CronCreate`, `TaskCreate`) and at most
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` of silence, replaced by the next turn; a PTY with no client is
  killed after `PTY_SESSION_TIMEOUT_MS` (30 minutes, `0` for never). `manual` is everything above:
  nothing closes without a request.
  In both modes a session never has two processes: the next turn waits for the previous process to be
  gone before starting its own.
- **`SESSION_PROCESS_EXTERNAL_PROCESSES`** (`shared/session-process-external.ts`), default off. When
  `true`, the Claude runtime installs the SDK's `spawnClaudeCodeProcess` hook to capture the pid of the
  CLI process it spawns, and every snapshot (`describeProcess`) walks the process table
  (`shared/external-process-tree.ts`) from that pid and reports its live OS descendants as
  `externalProcesses: [{ pid, name, startedAt }]` — a screen recording, a nested `claude` run, an Xcode
  build started through the shell, none of which the SDK ever declares as a `task` and so stay invisible
  once the turn that started them ends. Only descendants alive more than 5 seconds are counted, the CLI
  process itself is excluded, and the list is capped at 20; `name` is the executable's name only, never
  the command line. The session's own infrastructure is dropped with its subtree: MCP servers and
  language servers stay in the CLI's process group, while the CLI starts each `Bash` tool call detached,
  as its own group leader, so a descendant whose `pgid` is the CLI's own is the session running itself
  and one that leads its own group is the turn's work, everything below it included. The group is read
  off the CLI's own row, so the rule holds whether or not the CLI was itself spawned detached; if that
  row is missing (a `ps` read racing session shutdown) nothing is pruned, since listing too much beats
  reporting an idle session. The process-table read (`ps -axo pid=,ppid=,pgid=,lstart=,comm=`) is cached
  for 1 second so several snapshots a second cost one read. When the setting is off, `externalProcesses`
  is absent from the snapshot and nothing about how the CLI is spawned changes.

## Claude: tasks and subagents

The SDK announces the work a process runs beside the turn (the `Agent` tool's subagents, a
backgrounded `Bash`, `Monitor`, ...) as system messages `task_started`, `task_updated`
(a patch), `task_progress` and `task_notification` (the outcome, `completed` | `failed` |
`stopped`, with a summary). `claude-sessions.provider.ts` (`normalizeClaudeTaskMessage`) maps each
to one `task` message with the fields the event carries, in the shared status vocabulary (the
patch's `killed` reads `stopped`, `paused` stays `running`); the SDK exposes no
`background_tasks_changed` message, so nothing is done for one. Other system messages still
produce nothing. The `task_notification` kind stays Codex's; Claude's history reader keeps folding
the transcript's `<task-notification>` rows onto the `Agent` tool card, as before.

A `task_progress` frame's `description` is not the task's name but what it is busy with now — for
an agent, the child task it is waiting on — so it is normalized as `progress`, a field of its own
on the `task` message and on the record; `description` is set by `task_started` and by a
`task_updated` patch that renames the task, and nothing else touches it.

The runtime keeps the process's record of every task it saw (`recordTask`, a `SessionProcessTask`
per task id, kept after the task ended) and completes each outgoing `task` frame from it, so a
patch frame still names the task's description, agent type and tool call. `toolUseId` is only ever
taken from the first event that carries one: it names the call that *created* the task, which is
what its children point at, and a later event can name another (`SendMessage` resuming an agent
reports the resumption's call). The record is `SessionProcessSnapshot.tasks`, and the process is
announced again (`session_process`) when a task starts, ends, or comes back. A backgrounded agent
sends a `task_notification` every time it hands a result to the main thread, not only when it dies,
so an ended task that reports running again is taken at its word: the status is applied as it
comes and `endedAt` is dropped. The process reads one SDK stream in order, so such a status is
never a reordered straggler. `runtime.stopTask(sessionId, taskId)` (`IProviderRuntime`,
optional) calls the SDK's `stopTask` on the session's process; the CLI answers with a
`task_notification` of status `stopped`, which ends the record like any other. It refuses (false)
a session without a live process or a task the process never reported.

The SDK's task events never say which agent started the task: a `Bash` backgrounded inside a
subagent arrives with no `parent_tool_use_id`, while the `tool_use` block that spawned it came in an
assistant message carrying the `Agent` call's id at the top level. So the runtime remembers, per
process, the parent of every `tool_use` id it sees on the stream (`rememberToolUseParents`, the last
2000 ids) and, when a task's own event names no parent, fills `parentToolUseId` from that map
through the task's `toolUseId`, on the outgoing `task` frame and on the record alike. A task of the
session's own thread stays without one.

Each subagent's own transcript sits next to the session's, at
`<claudeHome>/projects/<encoded cwd>/<providerSessionId>/subagents/agent-<agentId>.jsonl` with an
`agent-<agentId>.meta.json` beside it (`agentType`, `description`, `toolUseId`).
`IProviderSessions.listAgents` and `fetchAgentHistory` (optional, Claude only today) expose them
over `GET /api/providers/sessions/:sessionId/agents` (`{ agents: SessionAgentSummary[] }`,
`messageCount` counts the agent's user and assistant rows) and
`GET /api/providers/sessions/:sessionId/agents/:agentId/messages`, which takes the same `limit` and
`offset` as the session's `/messages` and answers with the same envelope: the agent's rows go
through the same normalizer and page slicing (`normalizeTranscriptPage`), with `sessionId` set to
the app session id. `agentId` must match `[A-Za-z0-9_-]{1,64}`; an unknown one is a 404
`AGENT_NOT_FOUND`. Only the `<session>/subagents/` layout is listed: older CLIs dropped agent files
next to the parent with nothing tying them to a session, though `fetchAgentHistory` still finds
them by id.

## Claude: reading what a task is writing

A task's summary says how it went; the file it wrote says what it did. `GET
/api/providers/sessions/:sessionId/tasks/:taskId/output` serves a window of that file, addressed by
byte offset, so a client can poll forward while the task works and stop when it ends. It is a plain
read: no frame, no push, nothing to re-subscribe to after a reconnection — an offset is all a mobile
client has to remember.

```
GET /api/providers/sessions/app-7/tasks/b7k2m1x/output?offset=0&limit=65536
{ "data": { "sessionId": "app-7", "taskId": "b7k2m1x", "status": "running", "running": true,
            "outputFileSource": "derived", "encoding": "text", "content": "compiling…\n",
            "offset": 0, "nextOffset": 11, "bytesRead": 11, "size": 11, "truncated": false } }
```

- `offset` (bytes, default 0) or `tail` (the last N bytes, up to 1 MiB) — never both, which is a 400
  `INVALID_QUERY_PARAMETER`. A build log's interesting part is its end, and `tail` is how to open on
  it without walking the file.
- `limit` caps one answer: 64 KiB by default, 1 MiB at most, 1 KiB at least. Past the cap the answer
  is cut and `truncated: true` says so, with `nextOffset` naming where to carry on — a 40 MB
  `xcodebuild` log comes back in as many calls as the client cares to make, and never in one.
- `encoding` is `text` (default) or `base64`. A byte offset lands anywhere, including inside a
  multi-byte character: a `text` answer opens on the next whole character and stops before an
  unfinished one, and reports the `offset` and `nextOffset` it actually used, so nothing is ever cut
  in half and nothing is lost. `base64` hands back the window's bytes exactly as they are.
- `running` is false once the task completed, failed or was stopped: the client polls until it is
  false and `nextOffset === size`, then stops. `nextOffset` past a file that shrank comes back
  clamped to its size rather than an offset that can never be reached.

**The route never opens a path a caller supplied.** The file is resolved from the task's own record
on the session's process (`IProviderRuntime.describeTask`, Claude only today), by session id and task
id; `taskId` must match `[A-Za-z0-9_-]{1,64}`, and no parameter of this route names a file. The
record learns the path from three places, in this order:

- `task_notification.output_file` — the SDK's only announcement of it, and it arrives when the task
  *ends*. `normalizeClaudeTaskMessage` keeps it, `recordTask` stores it on the record
  (`SessionProcessTask.outputFile`, `outputFileSource: "announced"`).
- the tool result of an asynchronous agent's launch (`{ isAsync, agentId, outputFile }`), which names
  the file while the agent is still running. `rememberTaskOutputFiles` keeps it per process (the last
  500 ids), including for a task whose record does not exist yet.
- failing both, the path the CLI itself builds:
  `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<cwd with every non-alphanumeric character replaced by
  `-`>/<provider session id>/tasks/<task id>.output` (`outputFileSource: "derived"`). This is what
  makes a backgrounded `Bash` — the build whose log is the whole point — readable *while it runs*,
  since nothing announces its file before it ends. It is a construction, not a promise: the route
  serves it only if the file is there, and gives up on a working directory whose encoded form passes
  200 characters, where the CLI appends a hash of its own.

Each way of having nothing to serve is its own answer: 409 `SESSION_PROCESS_NOT_RUNNING` (the
session has no live process — a task's output is readable while its process lives, which under
`SESSION_PROCESS_CLOSE=manual` is until someone closes it), 404 `TASK_NOT_FOUND` (the process never
reported that task), 409 `TASK_OUTPUT_UNKNOWN` (the task is there but nothing can name its file),
404 `TASK_OUTPUT_NOT_FOUND` (the file is not there — a task that has written nothing yet), 403
`TASK_OUTPUT_UNREADABLE` (it will not open, or is not a file). None of them is an empty 200.

## Claude: what the model says it is doing

Between a tool call and the next sentence of prose, a turn used to be silent, and a client had
nothing to show but a spinner and a word of its own invention. The CLI's spinner verbs are not in
the stream and never were — they are its own decoration. Three SDK events *are* in the stream, and
this fork forwards all three.

**The summary — `tool_use_summary`.** The model's own sentence about the tool calls it has just
made, with the ids of those calls. `normalizeClaudeToolUseSummaryMessage` maps it to a message of
its own kind:

```json
{ "kind": "tool_use_summary", "id": "<uuid>", "sessionId": "app-7", "provider": "claude",
  "timestamp": "2026-09-20T09:14:02.881Z", "seq": 41,
  "summary": "Read the three config files and found the port",
  "precedingToolUseIds": ["toolu_1", "toolu_2", "toolu_3"] }
```

It is a frame rather than a field on the `tool_use` messages it describes, for two reasons: those
frames went out before it arrived, and one summary names several calls at once. A turn produces
several of them, and they are **captions, not a rolling status** — each belongs to the calls it
names. So a client attaches each to those tool cards, and uses only the most recent as the line it
shows in place of "Working…". A summary with no ids (`precedingToolUseIds: []`) is still a
summary; a summary with no sentence produces no frame.

**The status — `status` / `text: "activity"`.** The only thing in the stream that tells a
compaction apart from silence: while the CLI rewrites the context nothing else is emitted, at times
for a minute. It rides the existing `status` kind, discriminated by `text` the way `token_budget`
already is, so a client keeps one switch:

```json
{ "kind": "status", "text": "activity", "activity": "compacting" | "requesting" | null,
  "compactResult": "success" | "failed", "compactError": "…", "permissionMode": "plan",
  "id": "<uuid>", "sessionId": "app-7", "provider": "claude", "timestamp": "…", "seq": 42 }
```

`activity` is `null` when the CLI says it is doing neither, and also when it reports a status this
fork does not know — an unrecognised status reads as idle, never as itself. `compactResult` and
`compactError` are present only on the frame that ends a compaction, `permissionMode` only when the
CLI states one. A change of `activity` is the one thing here worth telling every client about, so
it re-announces the session's process (`session_process`); a summary or a token estimate does not.

**The thinking estimate — `status` / `text: "thinking_tokens"`.** During redacted thinking the API
streams only pings, so this running estimate is the sole sign of life:

```json
{ "kind": "status", "text": "thinking_tokens", "thinkingTokens": 2350,
  "id": "<uuid>", "sessionId": "app-7", "provider": "claude", "timestamp": "…", "seq": 43 }
```

Only the running total travels; the SDK's `estimated_tokens_delta` is the increment that produced
it, and a client that summed deltas would be summing the ones that got through. Because the CLI
digests one of these per `thinking_delta` — tens a second — the runtime forwards **at most one per
second** (`CLAUDE_THINKING_TOKENS_INTERVAL_MS`, default `1000`). The first estimate of a thinking
block always goes out, so the pill appears at once: `estimated_tokens` is the running total *of the
current block*, so a total no larger than the last one seen is a new block starting. The estimate
is approximate progress for a pill and is not the bill — `text: "token_budget"` remains the only
authority on tokens.

**None of the three is live-only by accident.** The CLI writes none of them into its JSONL
transcript, so nothing can be recovered from history after the fact, and this fork adds no storage
of its own: a summary's value is *while the turn runs*, and once the turn ends the reply it
narrated is in the transcript and is the better account. What a client arriving mid-turn needs is
covered twice over — `chat.subscribe` replays the buffered frames of a running run, and the
process's record carries the latest of each on `SessionProcessSnapshot.activity`, which
`chat_subscribed` hands over as `process`:

```json
"activity": { "status": "compacting", "compactResult": "success", "compactError": "…",
              "summary": "Ran the tests and they passed",
              "summaryToolUseIds": ["toolu_2", "toolu_3"], "thinkingTokens": 2350 }
```

`activity` is turn-scoped: it is cleared when a turn starts and when it ends, so a process sitting
between turns carries **no `activity` field at all** rather than an object full of nulls, and never
keeps answering with the last turn's sentence. It holds only the latest of each — the earlier
summaries are already on the client's timeline as frames. Every estimate updates
`activity.thinkingTokens`, including the ones the throttle drops, so a client arriving mid-turn
reads the real number rather than the last one that happened to be sent.

Tested in `server/modules/providers/tests/claude-activity.test.ts`: the three normalizers, a
summary reaching a subscribed client, a compaction announced going in and coming back out, the
record cleared at the end of the turn, and the throttle.
