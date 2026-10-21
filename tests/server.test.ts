import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.js';
import { parseSSE } from '../packages/providers/index.js';

test('local API: persistence, secrets, origin checks, cancellation and archive guards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-test-'));
  let runtime = await startServer({ port: 0, dataDir: dir });
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${runtime.port}/api${path}`, {
      method,
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal(
      (await call('/state', 'GET', undefined, { Origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal((await fetch(`http://127.0.0.1:${runtime.port}/api/state`)).status, 403);
    assert.equal(
      (
        await call('/providers/custom', 'PUT', {
          baseUrl: 'http://example.com',
          models: ['x'],
          protocol: 'openai',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call('/providers/custom', 'PUT', {
          baseUrl: 'https://example.com/v1',
          models: ['x'],
          protocol: 'openai',
          apiKey: 'secret-test-value',
        })
      ).status,
      200,
    );
    const publicState = await (await call('/state')).text();
    assert.ok(!publicState.includes('secret-test-value'));
    assert.ok(!readFileSync(join(dir, 'state.json'), 'utf8').includes('secret-test-value'));
    assert.equal(
      (
        await call('/providers/custom', 'PUT', {
          baseUrl: 'https://other.example/v1',
          models: ['x'],
          protocol: 'openai',
        })
      ).status,
      400,
    );
    const p = await (await call('/projects', 'POST', { name: 'Project' })).json();
    const c = await (
      await call('/conversations', 'POST', { mode: 'work', projectId: p.id })
    ).json();
    const response = await call(`/conversations/${c.id}/messages`, 'POST', {
      providerId: 'demo',
      model: '本地演示',
      content: 'hello',
    });
    assert.equal(response.status, 200);
    let cancelled = false,
      finished: any;
    for await (const raw of parseSSE(response.body!)) {
      const event = JSON.parse(raw);
      if (event.type === 'delta' && !cancelled) {
        cancelled = true;
        await call(`/conversations/${c.id}/cancel`, 'POST');
      }
      if (event.type === 'done') finished = event.conversation;
    }
    assert.equal(finished.messages.at(-1).status, 'cancelled');
    assert.ok(finished.messages.at(-1).content.length > 0);
    await call(`/conversations/${c.id}`, 'PATCH', { archived: true });
    assert.equal(
      (
        await call(`/conversations/${c.id}/messages`, 'POST', {
          providerId: 'demo',
          model: '本地演示',
          content: 'again',
        })
      ).status,
      400,
    );
    await runtime.close();
    runtime = await startServer({ port: 0, dataDir: dir });
    const persisted = await (await call('/state')).json();
    assert.equal(persisted.conversations[0].archived, true);
    assert.equal(persisted.providers.find((p: any) => p.id === 'custom').configured, false);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup API validates previews and preserves data and credentials on import', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-backup-'));
  const runtime = await startServer({ port: 0, dataDir: dir });
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.port}/api${path}`, {
      method,
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await call('/projects', 'POST', { name: '原始项目' });
    await call('/providers/custom', 'PUT', {
      baseUrl: 'https://example.com/v1',
      models: ['test'],
      protocol: 'openai',
      apiKey: 'backup-secret-test',
    });
    const backup = await (await call('/backups')).json();
    assert.ok(!JSON.stringify(backup).includes('backup-secret-test'));
    assert.ok(!JSON.stringify(backup).includes('https://example.com'));
    assert.equal((await call('/backups/preview', 'POST', backup)).status, 200);
    assert.equal((await call('/backups/import', 'POST', { ...backup, version: 99 })).status, 400);
    assert.equal(runtime.store.state.projects.length, 1);
    assert.equal((await call('/backups/import', 'POST', backup)).status, 200);
    assert.equal(runtime.store.state.projects.length, 2);
    const state = await (await call('/state')).json();
    assert.equal(state.providers.find((p: any) => p.id === 'custom').configured, true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).projects.length, 2);
    const c = await (await call('/conversations', 'POST', {})).json();
    const stream = await call(`/conversations/${c.id}/messages`, 'POST', {
      providerId: 'demo',
      model: '本地演示',
      content: 'test',
    });
    assert.equal((await call('/backups/import', 'POST', backup)).status, 409);
    assert.equal((await call('/backups')).status, 409);
    await call(`/conversations/${c.id}/cancel`, 'POST');
    await stream.text();
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project management moves chats, rejects invalid destinations and preserves archived content on deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-projects-'));
  let runtime = await startServer({ port: 0, dataDir: dir });
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.port}/api${path}`, {
      method,
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const p = await (await call('/projects', 'POST', { name: '原项目' })).json();
    const target = await (await call('/projects', 'POST', { name: '目标项目' })).json();
    assert.equal((await call(`/projects/${p.id}`, 'PATCH', { name: '  ' })).status, 400);
    assert.equal((await call('/projects/missing', 'PATCH', { name: '名称' })).status, 404);
    await call(`/projects/${p.id}`, 'PATCH', { name: '新名称', description: '项目范围' });
    const c = await (await call('/conversations', 'POST', { projectId: p.id })).json();
    const response = await call(`/conversations/${c.id}/messages`, 'POST', {
      providerId: 'demo',
      model: '本地演示',
      content: '保留消息',
      attachments: [{ name: 'a.txt', content: '附件内容' }],
    });
    assert.equal((await call(`/projects/${p.id}`, 'DELETE')).status, 409);
    assert.equal((await call(`/projects/${target.id}`, 'DELETE')).status, 409);
    assert.equal(
      (await call(`/conversations/${c.id}`, 'PATCH', { projectId: target.id })).status,
      409,
    );
    await call(`/conversations/${c.id}/cancel`, 'POST');
    await response.text();
    assert.equal(
      (await call(`/conversations/${c.id}`, 'PATCH', { projectId: 'missing' })).status,
      400,
    );
    await call(`/conversations/${c.id}`, 'PATCH', { projectId: target.id, archived: true });
    assert.equal(runtime.store.state.conversations[0].projectId, target.id);
    await call(`/projects/${target.id}`, 'DELETE');
    await runtime.close();
    runtime = await startServer({ port: 0, dataDir: dir });
    const persisted = await (await call('/state')).json();
    assert.equal(persisted.projects[0].name, '新名称');
    assert.equal(persisted.projects[0].description, '项目范围');
    assert.equal(persisted.conversations[0].projectId, null);
    assert.equal(persisted.conversations[0].archived, true);
    assert.equal(persisted.conversations[0].messages[0].attachments[0].content, '附件内容');
    assert.equal((await call(`/projects/${target.id}`, 'DELETE')).status, 404);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
