import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSSE,
  buildRequest,
  streamModel,
  type ModelRequest,
} from '../packages/providers/index.js';
import { providerDefaults } from '../packages/shared/types.js';
const request = (id: string): ModelRequest => ({
  provider: providerDefaults.find((p) => p.id === id)!,
  model: 'test-model',
  key: 'test-key',
  messages: [{ role: 'user', content: 'hello' }],
  system: 'be helpful',
  signal: new AbortController().signal,
});
test('SSE preserves Unicode and CRLF across arbitrary byte splits', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"你好"}\r\n\r\ndata: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of bytes) c.enqueue(new Uint8Array([b]));
      c.close();
    },
  });
  const out = [];
  for await (const item of parseSSE(body)) out.push(item);
  assert.deepEqual(out, ['{"text":"你好"}', '[DONE]']);
});
test('provider adapters use distinct authentication and request envelopes', () => {
  const openai = buildRequest(request('openai'));
  assert.equal(openai.url, 'https://api.openai.com/v1/responses');
  assert.equal(openai.headers.Authorization, 'Bearer test-key');
  assert.equal((openai.body as any).store, false);
  const claude = buildRequest(request('anthropic'));
  assert.equal(claude.headers['x-api-key'], 'test-key');
  assert.equal(claude.headers.Authorization, undefined);
  assert.equal((claude.body as any).max_tokens, 4096);
  const gemini = buildRequest(request('gemini'));
  assert.equal(
    gemini.url,
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  );
});
test('demo cancellation prevents further generation', async () => {
  const ctrl = new AbortController();
  const stream = streamModel({ ...request('demo'), signal: ctrl.signal });
  assert.equal((await stream.next()).done, false);
  ctrl.abort();
  await assert.rejects(() => stream.next());
});
test('truncated upstream streams are not silently marked successful', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  try {
    await assert.rejects(async () => {
      for await (const _ of streamModel(request('deepseek'))) {
      }
    }, /连接中断/);
  } finally {
    globalThis.fetch = original;
  }
});

test('all real protocol adapters decode text and normal completion', async () => {
  const original = globalThis.fetch;
  const streams = [
    {
      id: 'openai',
      events: [
        { type: 'response.output_text.delta', delta: '你好' },
        { type: 'response.completed' },
      ],
    },
    {
      id: 'anthropic',
      events: [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
        { type: 'message_stop' },
      ],
    },
    {
      id: 'gemini',
      events: [
        { choices: [{ delta: { content: '你好' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    },
  ];
  try {
    for (const item of streams) {
      globalThis.fetch = async () =>
        new Response(item.events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
      let text = '';
      for await (const chunk of streamModel(request(item.id))) text += chunk;
      assert.equal(text, '你好');
    }
  } finally {
    globalThis.fetch = original;
  }
});
