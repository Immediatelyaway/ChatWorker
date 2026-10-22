import { test } from 'node:test';
import assert from 'node:assert/strict';
import { send, state, ui, forkConversation } from '../apps/web/src/composables/workspace.js';
import type { Conversation } from '../packages/shared/types.js';

test('a failed final save preserves the visible reply and its specific error for copying', async () => {
  const originalFetch = globalThis.fetch;
  const at = new Date().toISOString();
  state.conversations = [
    {
      id: 'unsaved',
      title: '新会话',
      projectId: null,
      mode: 'chat',
      archived: false,
      createdAt: at,
      updatedAt: at,
      messages: [],
      activities: [],
    },
  ];
  state.providers = [
    {
      id: 'demo',
      name: '演示',
      protocol: 'demo',
      baseUrl: '',
      models: ['model'],
      configured: true,
    },
  ];
  state.preferences.providerId = 'demo';
  state.preferences.model = 'model';
  ui.activeId = 'unsaved';
  ui.busyId = '';
  ui.preparing = false;
  let reloads = 0;
  const message = '回复未能保存，请先复制当前内容';
  globalThis.fetch = async (input) => {
    if (input === '/api/state') {
      reloads++;
      return Response.json({ ...state, runtime: ui.runtime });
    }
    assert.equal(input, '/api/conversations/unsaved/messages');
    const events = [
      { type: 'delta', text: '需要保留的回复' },
      { type: 'error', code: 'persistence_failed', message },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  };
  try {
    assert.equal(await send('问题', []), false);
    assert.equal(ui.error, message);
    assert.equal(state.conversations[0].messages.at(-1)?.content, '需要保留的回复');
    assert.equal(state.conversations[0].messages.at(-1)?.status, 'failed');
    const replyId = state.conversations[0].messages.at(-1)!.id;
    assert.equal(ui.unsavedReplies.has(replyId), true);
    await forkConversation(replyId, 'retry');
    assert.equal(reloads, 0, 'do not replace unsaved text with the durable empty placeholder');
    assert.equal(ui.busyId, '');
    assert.equal(ui.preparing, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UI reserves send before creating a conversation and snapshots the selected model', async () => {
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const at = new Date().toISOString();
  const c: Conversation = {
    id: 'new',
    title: '问题',
    projectId: null,
    mode: 'chat',
    archived: false,
    createdAt: at,
    updatedAt: at,
    messages: [],
    activities: [],
  };
  let creations = 0,
    requests = 0;
  state.conversations = [];
  state.providers = [
    {
      id: 'demo',
      name: '演示',
      protocol: 'demo',
      baseUrl: '',
      models: ['selected-model'],
      configured: true,
    },
  ];
  state.preferences.providerId = 'demo';
  state.preferences.model = 'selected-model';
  ui.busyId = '';
  ui.preparing = false;
  ui.activeId = '';
  globalThis.fetch = async (input, options) => {
    if (input === '/api/conversations') {
      creations++;
      await pending;
      return Response.json(c);
    }
    if (input === '/api/conversations/new/messages') {
      requests++;
      const body = JSON.parse(String(options!.body));
      assert.equal(body.model, 'selected-model');
      return new Response(`data: ${JSON.stringify({ type: 'done', conversation: c })}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    throw new Error('Unexpected request');
  };
  try {
    const first = send('问题', []);
    assert.equal(ui.preparing, true);
    assert.equal(await send('重复点击', []), false);
    state.preferences.model = 'changed-model';
    release();
    assert.equal(await first, true);
    assert.equal(creations, 1);
    assert.equal(requests, 1);
    assert.equal(ui.preparing, false);
    assert.equal(ui.busyId, '');
  } finally {
    release();
    globalThis.fetch = originalFetch;
  }
});

test('send lifecycle keeps draft until server acceptance and does not clear on rejection', async () => {
  const originalFetch = globalThis.fetch;
  const at = new Date().toISOString();
  const c: Conversation = {
    id: 'draft-chat',
    title: '新会话',
    projectId: null,
    mode: 'chat',
    archived: false,
    createdAt: at,
    updatedAt: at,
    messages: [],
    activities: [],
  };
  const events: string[] = [];
  state.conversations = [];
  state.providers = [
    {
      id: 'demo',
      name: '演示',
      protocol: 'demo',
      baseUrl: '',
      models: ['model'],
      configured: true,
    },
  ];
  state.preferences.providerId = 'demo';
  state.preferences.model = 'model';
  ui.activeId = '';
  ui.busyId = '';
  ui.preparing = false;
  let reject = true;
  globalThis.fetch = async (input) => {
    if (input === '/api/conversations') return Response.json(c);
    if (input === '/api/state') return Response.json({ ...state, runtime: ui.runtime });
    if (reject) return Response.json({ error: '测试发送失败' }, { status: 400 });
    return new Response(`data: ${JSON.stringify({ type: 'done', conversation: c })}\n\n`);
  };
  const callbacks = {
    created: (id: string) => {
      events.push('created:' + id);
    },
    accepted: () => events.push('accepted'),
  };
  try {
    assert.equal(await send('问题', [], false, callbacks), false);
    assert.deepEqual(events, ['created:draft-chat']);
    reject = false;
    assert.equal(await send('问题', [], false, callbacks), true);
    assert.deepEqual(events, ['created:draft-chat', 'accepted']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
