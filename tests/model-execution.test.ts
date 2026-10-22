import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../apps/server/src/index.js';
import { Storage } from '../apps/server/src/storage.js';
import {
  buildRequest,
  streamModelEvents,
  parseSSE,
  type ModelRequest,
  type ModelEvent,
} from '../packages/providers/index.js';
import { providerError } from '../packages/providers/errors.js';
import { providerDefaults } from '../packages/shared/types.js';
import { exportBackup, importBackup } from '../apps/server/src/backup.js';
const request = (model = 'deepseek-flash'): ModelRequest => ({
  provider: providerDefaults.find((p) => p.id === 'deepseek')!,
  model,
  key: 'fake-key',
  messages: [{ role: 'user', content: 'hi' }],
  system: 'brief',
  signal: new AbortController().signal,
});
const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';

test('thinking options are model-specific, disabled omits effort, other endpoints keep their defaults', () => {
  const r = request();
  let body = buildRequest({ ...r, options: { thinking: 'enabled', effort: 'max' } }).body as any;
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'max');
  body = buildRequest({ ...r, options: { thinking: 'disabled', effort: 'max' } }).body;
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, undefined);
  body = buildRequest({
    ...r,
    options: {},
    provider: { ...r.provider, baseUrl: 'https://other.example/v1' },
  }).body;
  assert.equal(body.thinking, undefined);
  assert.equal(body.stream_options, undefined);
  body = buildRequest({ ...r, model: 'arbitrary-model', options: { effort: 'max' } }).body;
  assert.equal(body.reasoning_effort, undefined);
});

test('provider streams separate reasoning, answer and measured usage; unexpected tools are never treated as completed', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        frame({ choices: [{ delta: { reasoning_content: '先核对条件。', content: '答案' } }] }) +
          frame({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 8,
              completion_tokens_details: { reasoning_tokens: 5 },
            },
          }) +
          'data: [DONE]\n\n',
      );
    const events = [];
    for await (const event of streamModelEvents(request())) events.push(event);
    assert.deepEqual(
      events.map((e) => e.type),
      ['connected', 'reasoning', 'text', 'usage'],
    );
    assert.equal((events[1] as any).text, '先核对条件。');
    assert.equal((events[3] as any).usage.reasoningTokens, 5);
    globalThis.fetch = async () =>
      new Response(
        frame({ choices: [{ delta: { tool_calls: [{ function: { name: 'search_web' } }] } }] }),
      );
    const toolEvents: ModelEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of streamModelEvents(request())) toolEvents.push(event);
    }, /未执行/);
    assert.deepEqual(
      toolEvents.map((e) => e.type),
      ['connected', 'tool'],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('provider errors classify without exposing echoed credentials or user content', async () => {
  for (const [message, category] of [
    ['Model Not Found; fake-key confidential prompt', 'model'],
    ['Missing reasoning_content; private', 'reasoning_history'],
    ['maximum context length reached', 'context'],
  ]) {
    const error = await providerError(
      new Response(JSON.stringify({ error: { message } }), { status: 400 }),
    );
    assert.equal(error.category, category);
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /fake-key|confidential|private/);
  }
  const html = await providerError(new Response('<html>fake-key</html>', { status: 402 }));
  assert.match(html.message, /余额不足/);
  assert.doesNotMatch(html.message, /fake-key/);
});

test('connection tests accept the first reasoning delta, expose upstream status distinctly, and return only provider metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-model-test-'));
  const runtime = await startServer({ port: 0, dataDir: dir });
  const original = globalThis.fetch;
  const call = (path: string, body?: unknown) =>
    original(`http://127.0.0.1:${runtime.port}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    await original(`http://127.0.0.1:${runtime.port}/api/providers/deepseek`, {
      method: 'PUT',
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.deepseek.com',
        protocol: 'openai',
        models: ['deepseek-flash', 'deepseek-v4-pro'],
        apiKey: 'fake-key',
      }),
    });
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                frame({ choices: [{ delta: { reasoning_content: 'thinking' } }] }),
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    const test = await call('/providers/deepseek/test', { model: 'deepseek-flash' });
    assert.equal(test.status, 200);
    assert.equal((await test.json()).responseKind, 'reasoning');
    assert.equal(cancelled, true);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'Model Not Found fake-key' } }), {
        status: 400,
      });
    const bad = await call('/providers/deepseek/test', { model: 'not-existing' });
    assert.equal(bad.status, 502);
    const error = await bad.json();
    assert.equal(error.upstreamStatus, 400);
    assert.equal(error.category, 'model');
    assert.doesNotMatch(JSON.stringify(error), /fake-key/);
    const metadata = await (await call('/providers/deepseek')).json();
    assert.ok(metadata.configured);
    assert.equal(metadata.conversations, undefined);
    assert.equal(metadata.apiKey, undefined);
  } finally {
    globalThis.fetch = original;
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model configuration and execution details survive API, storage reopen and conversation backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-execution-'));
  let runtime = await startServer({ port: 0, dataDir: dir });
  const original = globalThis.fetch;
  const call = (path: string, method = 'GET', body?: unknown) =>
    original(`http://127.0.0.1:${runtime.port}/api${path}`, {
      method,
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await call('/providers/deepseek', 'PUT', {
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      apiKey: 'fake-key',
    });
    for (const [model, options] of [
      ['deepseek-flash', { thinking: 'disabled' }],
      ['deepseek-v4-pro', { thinking: 'enabled', effort: 'max' }],
    ] as const)
      assert.equal(
        (await call('/providers/deepseek/model-options', 'PUT', { model, options })).status,
        200,
      );
    assert.equal(
      (
        await call('/providers/deepseek/model-options', 'PUT', {
          model: 'deepseek-v4-pro',
          options: { effort: 'ultra' },
        })
      ).status,
      400,
    );
    let sent: any;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        frame({ choices: [{ delta: { reasoning_content: '核对材料' } }] }) +
          frame({ choices: [], usage: { prompt_tokens: 10 } }) +
          frame({ choices: [{ delta: { content: '已完成回答' } }] }) +
          frame({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { completion_tokens: 6 },
          }) +
          'data: [DONE]\n\n',
      );
    };
    const conversation = await (await call('/conversations', 'POST', { mode: 'work' })).json();
    const response = await call(`/conversations/${conversation.id}/messages`, 'POST', {
      content: '请解释',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    const events = [];
    for await (const raw of parseSSE(response.body!)) events.push(JSON.parse(raw));
    assert.equal(sent.reasoning_effort, 'max');
    assert.deepEqual(sent.thinking, { type: 'enabled' });
    assert.ok(events.some((e) => e.type === 'reasoning'));
    assert.ok(events.some((e) => e.type === 'execution'));
    const answer = events.find((e) => e.type === 'done').conversation.messages.at(-1);
    assert.equal(answer.execution.reasoning, '核对材料');
    assert.equal(answer.content, '已完成回答');
    assert.equal(answer.execution.usage.inputTokens, 10);
    assert.ok(answer.execution.events.every((e: any) => e.status === 'completed'));
    assert.ok(answer.execution.events.every((e: any) => !e.label.startsWith('正在')));
    const backup = exportBackup(runtime.store.state);
    const imported = importBackup(runtime.store.state, backup);
    assert.equal(imported.conversations[0].messages.at(-1)?.execution?.reasoning, '核对材料');
    await runtime.close();
    runtime = await startServer({ port: 0, dataDir: dir });
    assert.equal(
      runtime.store.state.conversations[0].messages.at(-1)?.execution?.reasoning,
      '核对材料',
    );
    assert.deepEqual(
      runtime.store.state.providers.find((p) => p.id === 'deepseek')?.modelOptions?.[
        'deepseek-flash'
      ],
      { thinking: 'disabled' },
    );
  } finally {
    globalThis.fetch = original;
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v2 upgrade preserves drafts and exact backup; a failed model schema upgrade rolls back', async () => {
  for (const fail of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'chatworker-model-migrate-'));
    try {
      const before = await Storage.open(dir);
      const id = before.storeId;
      await before.writeDraft('new:work:', {
        expectedRevision: 0,
        draft: { text: '原草稿', attachments: [] },
      });
      await before.close();
      const file = join(dir, 'state.sqlite');
      const db = new DatabaseSync(file);
      db.exec(
        'ALTER TABLE messages DROP COLUMN execution_json; ALTER TABLE providers DROP COLUMN model_options_json; PRAGMA user_version=2;',
      );
      if (fail) db.exec('ALTER TABLE messages ADD COLUMN execution_json TEXT;');
      db.close();
      const bytes = readFileSync(file);
      if (fail) {
        await assert.rejects(Storage.open(dir));
        const check = new DatabaseSync(file);
        try {
          assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 2);
          assert.ok(
            !check
              .prepare('PRAGMA table_info(providers)')
              .all()
              .some((c) => c.name === 'model_options_json'),
          );
        } finally {
          check.close();
        }
      } else {
        const after = await Storage.open(dir);
        try {
          assert.equal(after.storeId, id);
          assert.equal((await after.readDraft('new:work:')).draft.text, '原草稿');
          await after.update((state) => {
            const at = new Date().toISOString();
            state.conversations.push({
              id: 'upgraded',
              title: '升级后写入',
              projectId: null,
              mode: 'work',
              archived: false,
              createdAt: at,
              updatedAt: at,
              activities: [],
              messages: [
                {
                  id: 'answer',
                  role: 'assistant',
                  content: '正文',
                  createdAt: at,
                  execution: { events: [], reasoning: '思考' },
                },
              ],
            });
          });
          assert.equal(after.state.conversations[0].messages[0].execution?.reasoning, '思考');
        } finally {
          await after.close();
        }
      }
      const backup = readdirSync(dir).find((n) => n.startsWith('state.sqlite.backup-v2-'))!;
      assert.deepEqual(readFileSync(join(dir, backup)), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
