import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { branchConversation } from '../apps/server/src/branches.js';
import { startServer } from '../apps/server/src/index.js';
import type { Conversation } from '../packages/shared/types.js';

function fixture(): Conversation {
  const at = new Date().toISOString();
  return {
    id: 'original',
    title: '分析代码',
    projectId: 'project',
    mode: 'work',
    archived: true,
    createdAt: at,
    updatedAt: at,
    activities: [],
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: '第一个问题',
        attachments: [{ name: 'code.ts', content: 'const context = 42' }],
        createdAt: at,
      },
      { id: 'a1', role: 'assistant', content: '原始回答', status: 'completed', createdAt: at },
      { id: 'u2', role: 'user', content: '不能出现在早期分支的后续问题', createdAt: at },
      { id: 'a2', role: 'assistant', content: '后续答案', status: 'cancelled', createdAt: at },
    ],
  };
}

test('branch copies only selected history with independent IDs and attachments', () => {
  const original = fixture();
  const snapshot = structuredClone(original);
  const continued = branchConversation(original, 'a1', 'continue');
  assert.equal(continued.messages.length, 2);
  assert.equal(continued.projectId, original.projectId);
  assert.equal(continued.mode, 'work');
  assert.equal(continued.archived, false);
  assert.notEqual(continued.messages[0].id, original.messages[0].id);
  continued.messages[0].attachments![0].content = '改变副本';
  assert.deepEqual(original, snapshot);
  const retry = branchConversation(original, 'a1', 'retry');
  assert.equal(retry.messages.length, 1);
  assert.equal(retry.messages[0].role, 'user');
  assert.equal(branchConversation(original, 'a2', 'retry').messages.length, 3);
  assert.throws(() => branchConversation(original, 'missing', 'continue'));
  assert.throws(() => branchConversation(original, 'u1', 'retry'));
  original.messages[3].status = 'streaming';
  assert.throws(() => branchConversation(original, 'a1', 'continue'));
});

test('retry API uses copied user context once, preserves source and persists generated branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-branches-'));
  let received: any;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"新回答"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  let runtime = await startServer({ port: 0, dataDir: dir });
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.port}/api${path}`, {
      method,
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const source = fixture();
    runtime.store.state.projects.push({ id: 'project', name: '项目', description: '' });
    runtime.store.state.conversations.push(source);
    runtime.store.save();
    const snapshot = structuredClone(source);
    assert.equal(
      (await call('/conversations/missing/branch', 'POST', { messageId: 'a1', intent: 'retry' }))
        .status,
      404,
    );
    assert.equal(
      (await call('/conversations/original/branch', 'POST', { messageId: 'u1', intent: 'retry' }))
        .status,
      400,
    );
    assert.equal(
      (await call('/conversations/original/branch', 'POST', { messageId: 'a1', intent: 'invalid' }))
        .status,
      400,
    );
    const continued = await (
      await call('/conversations/original/branch', 'POST', { messageId: 'a1', intent: 'continue' })
    ).json();
    assert.equal(continued.messages.length, 2);
    const branch = await (
      await call('/conversations/original/branch', 'POST', { messageId: 'a1', intent: 'retry' })
    ).json();
    await call('/providers/custom', 'PUT', {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: ['mock'],
      protocol: 'openai',
      apiKey: 'test-key',
    });
    const response = await call(`/conversations/${branch.id}/messages`, 'POST', {
      reuseLastUser: true,
      providerId: 'custom',
      model: 'mock',
      content: '忽略客户端伪造内容',
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(received.messages.filter((m: any) => m.role === 'user').length, 1);
    assert.match(received.messages.at(-1).content, /第一个问题/);
    assert.match(received.messages.at(-1).content, /const context = 42/);
    assert.ok(!JSON.stringify(received).includes('不能出现在早期分支'));
    assert.ok(!JSON.stringify(received).includes('伪造'));
    assert.equal(
      (
        await call(`/conversations/${branch.id}/messages`, 'POST', {
          reuseLastUser: true,
          providerId: 'custom',
          model: 'mock',
        })
      ).status,
      409,
    );
    assert.deepEqual(
      runtime.store.state.conversations.find((c) => c.id === source.id),
      snapshot,
    );
    await runtime.close();
    runtime = await startServer({ port: 0, dataDir: dir });
    const saved = runtime.store.state.conversations.find((c) => c.id === branch.id)!;
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[1].content, '新回答');
    assert.equal(saved.messages[1].status, 'completed');
    assert.equal(saved.archived, false);
    assert.equal(saved.projectId, 'project');
    const active = await call(`/conversations/${branch.id}/messages`, 'POST', {
      providerId: 'demo',
      model: '本地演示',
      content: '运行中',
    });
    assert.equal(
      (
        await call(`/conversations/${branch.id}/branch`, 'POST', {
          messageId: saved.messages[1].id,
          intent: 'continue',
        })
      ).status,
      409,
    );
    await call(`/conversations/${branch.id}/cancel`, 'POST');
    await active.text();
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
