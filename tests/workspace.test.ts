import { test } from 'node:test';
import assert from 'node:assert/strict';
import { send, state, ui } from '../apps/web/src/composables/workspace.js';
import type { Conversation } from '../packages/shared/types.js';

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
