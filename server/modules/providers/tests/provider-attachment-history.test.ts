import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CodexSessionsProvider, extractCodexUserImages } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { CursorSessionsProvider } from '@/modules/providers/list/cursor/cursor-sessions.provider.js';
import { appendFilesInputTag, appendImagesInputTag } from '@/shared/image-attachments.js';

const SESSION_ID = 'session-1';

// ---------------------------------------------------------------- Claude

test('claude history: base64 image blocks surface as user message images', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u1',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this screenshot?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' } },
      ],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'What is in this screenshot?');
  assert.deepEqual(messages[0].images, [
    { data: 'data:image/png;base64,QUJD' },
    { data: 'data:image/jpeg;base64,REVG' },
  ]);
});

test('claude history: image-only user turns still produce a bubble', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u2',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      ],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '');
  assert.deepEqual(messages[0].images, [{ data: 'data:image/png;base64,QUJD' }]);
});

test('claude history: plain text user turns carry no images field', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u3',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].images, undefined);
});

test('claude history: the CLI\'s persisted image-resize note is flagged generated, not dropped', () => {
  const provider = new ClaudeSessionsProvider();
  // Shape written to the JSONL transcript: its own row, `isMeta`+`turnCompanion`
  // true, content is the note text only — never merged into the turn that
  // carried the image.
  const entry = {
    uuid: 'u-note-history',
    parentUuid: 'u-image-turn',
    timestamp: '2026-07-03T10:00:01.000Z',
    type: 'user',
    isMeta: true,
    turnCompanion: true,
    message: {
      role: 'user',
      content: '[Image: original 1200x3000, displayed at 800x2000. Multiply coordinates by 1.50 to map to original image.]',
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].generated, true);
  assert.match(messages[0].content || '', /original 1200x3000/);
});

test('claude live: the same note streams with isSynthetic instead of isMeta, and is flagged the same way', () => {
  const provider = new ClaudeSessionsProvider();
  // Shape the SDK actually streams live: `isSynthetic` rather than `isMeta`
  // (isMeta never made it into the SDK's typed SDKUserMessage), content as a
  // text-only part array rather than a bare string.
  const entry = {
    type: 'user',
    isSynthetic: true,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '[Image: original 1200x3000, displayed at 800x2000. Multiply coordinates by 1.50 to map to original image.]' },
      ],
    },
    parent_tool_use_id: null,
    session_id: 'provider-session-1',
    uuid: 'u-note-live',
    timestamp: '2026-07-03T10:00:01.000Z',
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].generated, true);
  assert.match(messages[0].content || '', /original 1200x3000/);
});

test('claude history: a skill-body injection keeps its existing isMeta drop, unaffected by the new flag', () => {
  const provider = new ClaudeSessionsProvider();
  // Also isMeta + turnCompanion + pure text, but carries `sourceToolUseID`
  // linking it back to the Skill tool call — the field that tells it apart
  // from the tool's image note, which never has one.
  const entry = {
    uuid: 'u-skill-body',
    timestamp: '2026-07-03T10:00:01.000Z',
    type: 'user',
    isMeta: true,
    turnCompanion: true,
    sourceToolUseID: 'toolu_skill_1',
    message: {
      role: 'user',
      content: 'Base directory for this skill: /Users/x/.claude/skills/graphify\n\n# /graphify',
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages.length, 0);
});

test('claude live/history: a user turn with an image and no CLI note carries no generated flag', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u-plain-image',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this screenshot?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      ],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].generated, undefined);
});

test('claude history: a plain text turn with no image carries no generated flag', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u-plain-text',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: { role: 'user', content: 'just a normal message' },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].generated, undefined);
});

test('claude history: user-typed text with square brackets is never marked generated', () => {
  const provider = new ClaudeSessionsProvider();
  // No isMeta/isSynthetic marker at all — a real user row, even though its
  // own wording happens to look like the CLI's note. The detector must not
  // be fooled by the text shape alone.
  const entry = {
    uuid: 'u-brackets',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: '[Image: original 100x100, displayed at 100x100] please check this section',
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].generated, undefined);
  assert.equal(messages[0].content, '[Image: original 100x100, displayed at 100x100] please check this section');
});

test('claude history: file reference blocks restore non-image attachments', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u4',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: appendFilesInputTag('Summarize this', [
          { path: 'C:/Users/x/.cloudcli/assets/brief.pdf', name: 'brief.pdf' },
        ]),
      }],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages[0].content, 'Summarize this');
  assert.deepEqual(messages[0].files, [
    { path: 'C:/Users/x/.cloudcli/assets/brief.pdf', name: 'brief.pdf' },
  ]);
});

// ---------------------------------------------------------------- Codex

test('codex history: user_message payload images become path attachments', () => {
  // Real rollout shape: local_image input items land in `local_images`,
  // while `images` stays an empty array.
  assert.deepEqual(
    extractCodexUserImages({
      type: 'user_message',
      message: 'can u see attached image?',
      images: [],
      local_images: ['C:\\proj\\.cloudcli\\assets\\a.png'],
    }),
    [{ path: 'C:/proj/.cloudcli/assets/a.png' }],
  );
  assert.deepEqual(
    extractCodexUserImages({ type: 'user_message', message: 'hi', images: ['/proj/b.jpg'] }),
    [{ path: '/proj/b.jpg' }],
  );
  assert.equal(extractCodexUserImages({ type: 'user_message', message: 'hi' }), undefined);
  assert.equal(extractCodexUserImages({ type: 'user_message', message: 'hi', images: [], local_images: [] }), undefined);
});

test('codex history: base64 data URLs pass through as inline data attachments', () => {
  const dataUrl = 'data:image/png;base64,QUJD';
  assert.deepEqual(
    extractCodexUserImages({
      type: 'user_message',
      message: 'look',
      images: [dataUrl],
      local_images: ['C:\\proj\\a.png'],
    }),
    [{ path: 'C:/proj/a.png' }, { data: dataUrl }],
  );
});

test('codex history: normalized user entries keep their images', () => {
  const provider = new CodexSessionsProvider();
  const messages = provider.normalizeMessage(
    {
      timestamp: '2026-07-03T10:00:00.000Z',
      message: { role: 'user', content: 'Look at this' },
      images: [{ path: '.cloudcli/assets/a.png' }],
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Look at this');
  assert.deepEqual(messages[0].images, [{ path: '.cloudcli/assets/a.png' }]);
});

test('codex history: normalized user entries restore file reference blocks', () => {
  const provider = new CodexSessionsProvider();
  const messages = provider.normalizeMessage(
    {
      timestamp: '2026-07-03T10:00:00.000Z',
      message: {
        role: 'user',
        content: appendFilesInputTag('Review this', [
          { path: 'C:/Users/x/.cloudcli/assets/spec.docx', name: 'spec.docx' },
        ]),
      },
    },
    SESSION_ID,
  );

  assert.equal(messages[0].content, 'Review this');
  assert.deepEqual(messages[0].files, [
    { path: 'C:/Users/x/.cloudcli/assets/spec.docx', name: 'spec.docx' },
  ]);
});

// ---------------------------------------------------------------- Cursor

test('cursor history: <images_input> inside user_query is stripped and attached', () => {
  const provider = new CursorSessionsProvider();
  const taggedPrompt = appendImagesInputTag('Fix the layout bug', [{ path: '.cloudcli/assets/shot.png' }]);
  const blobs = [
    {
      id: 'blob1',
      sequence: 1,
      rowid: 1,
      content: {
        role: 'user',
        content: `<timestamp>2026-07-03</timestamp>\n<user_query>${taggedPrompt}</user_query>`,
      },
    },
    {
      id: 'blob2',
      sequence: 2,
      rowid: 2,
      content: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done — the flex container was wrong.' }],
      },
    },
  ];

  const messages = provider.normalizeCursorBlobs(blobs, SESSION_ID);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Fix the layout bug');
  assert.deepEqual(messages[0].images, [{ path: '.cloudcli/assets/shot.png' }]);
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].images, undefined);
});

test('cursor history: user text without a tag keeps existing behavior', () => {
  const provider = new CursorSessionsProvider();
  const blobs = [
    {
      id: 'blob1',
      sequence: 1,
      rowid: 1,
      content: {
        role: 'user',
        content: '<timestamp>2026-07-03</timestamp>\n<user_query>plain question</user_query>',
      },
    },
  ];

  const messages = provider.normalizeCursorBlobs(blobs, SESSION_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'plain question');
  assert.equal(messages[0].images, undefined);
});

test('cursor history: file reference blocks are stripped and attached', () => {
  const provider = new CursorSessionsProvider();
  const taggedPrompt = appendFilesInputTag('Check the data', [
    { path: 'C:/Users/x/.cloudcli/assets/data.csv', name: 'data.csv' },
  ]);
  const messages = provider.normalizeCursorBlobs([
    {
      id: 'blob-file',
      sequence: 1,
      rowid: 1,
      content: {
        role: 'user',
        content: `<user_query>${taggedPrompt}</user_query>`,
      },
    },
  ], SESSION_ID);

  assert.equal(messages[0].content, 'Check the data');
  assert.deepEqual(messages[0].files, [
    { path: 'C:/Users/x/.cloudcli/assets/data.csv', name: 'data.csv' },
  ]);
});
