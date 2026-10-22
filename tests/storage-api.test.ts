import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../apps/server/src/index.js';
import { parseSSE } from '../packages/providers/index.js';

test('failed credential writes cannot send an old saved or environment key to a changed endpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatworker-vault-failure-'));
  const previousEnvironmentKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-environment-only';
  let saved = 'test-old-key';
  const runtime = await startServer({
    port: 0,
    dataDir: directory,
    secrets: {
      persistent: false,
      get: () => saved,
      set: (_id, value) => {
        if (value) throw new Error('simulated vault failure');
        saved = '';
      },
    },
  });
  try {
    const call = (path: string, method: string, body: unknown) =>
      fetch(`http://127.0.0.1:${runtime.port}/api${path}`, {
        method,
        headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const response = await call('/providers/openai', 'PUT', {
      baseUrl: 'http://127.0.0.1:9/v1',
      protocol: 'responses',
      models: ['test-model'],
      apiKey: 'test-new-key',
    });
    assert.equal(response.status, 500);
    assert.equal(saved, '');
    assert.equal(
      runtime.store.state.providers.find((p) => p.id === 'openai')?.baseUrl,
      'http://127.0.0.1:9/v1',
    );
    const probe = await call('/providers/openai/test', 'POST', { model: 'test-model' });
    assert.equal(probe.status, 400);
    assert.match((await probe.json()).error, /保存 API Key/);
  } finally {
    await runtime.close();
    if (previousEnvironmentKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousEnvironmentKey;
    rmSync(directory, { recursive: true, force: true });
  }
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'chatworker-storage-api-'));
  const runtime = await startServer({ port: 0, dataDir: directory });
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.port}/api${path}`, {
      method,
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    directory,
    runtime,
    call,
    cleanup: async () => {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('failed SQL transaction leaves API memory and previous records unchanged; queued edits do not lose writes', async () => {
  const context = await setup();
  const db = new DatabaseSync(join(context.directory, 'state.sqlite'));
  try {
    await context.call('/projects', 'POST', { name: '已保存' });
    const before = structuredClone(context.runtime.store.state);
    db.exec(
      "CREATE TRIGGER fail_insert BEFORE INSERT ON projects WHEN NEW.name='拒绝保存' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;",
    );
    assert.equal((await context.call('/projects', 'POST', { name: '拒绝保存' })).status, 500);
    assert.deepEqual(context.runtime.store.state, before);
    assert.equal(db.prepare('SELECT count(*) AS count FROM projects').get()?.count, 1);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        context.call('/projects', 'POST', { name: `并发项目 ${i}` }),
      ),
    );
    assert.ok(results.every((response) => response.status === 200));
    assert.equal(context.runtime.store.state.projects.length, 9);
    assert.equal(db.prepare('SELECT count(*) AS count FROM projects').get()?.count, 9);
  } finally {
    db.close();
    await context.cleanup();
  }
});

test('a worker waiting on a database lock does not block capability reads', async () => {
  const context = await setup();
  const db = new DatabaseSync(join(context.directory, 'state.sqlite'));
  let write: Promise<Response> | undefined;
  try {
    db.exec('BEGIN EXCLUSIVE');
    let settled = false;
    write = context.call('/projects', 'POST', { name: '等待锁' }).finally(() => {
      settled = true;
    });
    await delay(40);
    const response = await context.call('/v1/capabilities');
    assert.equal(response.status, 200);
    assert.equal(settled, false, 'HTTP remained responsive while the worker waited');
    db.exec('ROLLBACK');
    assert.equal((await write).status, 200);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    await write;
    db.close();
    await context.cleanup();
  }
});

test('failed initial or final message persistence never reports success or leaks the active lock', async () => {
  const context = await setup();
  const db = new DatabaseSync(join(context.directory, 'state.sqlite'));
  try {
    const c = await (await context.call('/conversations', 'POST', {})).json();
    const send = () =>
      context.call(`/conversations/${c.id}/messages`, 'POST', {
        providerId: 'demo',
        model: '本地演示',
        content: '保存验证',
      });
    db.exec(
      "CREATE TRIGGER fail_start BEFORE INSERT ON messages WHEN NEW.status='streaming' BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;",
    );
    assert.equal((await send()).status, 500);
    assert.equal(context.runtime.store.state.conversations[0].messages.length, 0);
    db.exec('DROP TRIGGER fail_start');
    db.exec(
      "CREATE TRIGGER fail_finish BEFORE INSERT ON messages WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'simulated final write failure'); END;",
    );
    const response = await send();
    assert.equal(response.status, 200);
    const events: any[] = [];
    for await (const raw of parseSSE(response.body!)) events.push(JSON.parse(raw));
    assert.ok(
      events.some(
        (event) =>
          event.type === 'error' &&
          event.code === 'persistence_failed' &&
          event.message.includes('未能保存'),
      ),
    );
    assert.equal(
      events.some((event) => event.type === 'done'),
      false,
    );
    assert.equal(context.runtime.store.state.conversations[0].messages.at(-1)?.status, 'streaming');
    assert.equal(
      (await context.call(`/conversations/${c.id}`, 'PATCH', { title: '锁已释放' })).status,
      200,
    );
    db.exec('DROP TRIGGER fail_finish');
  } finally {
    db.close();
    await context.cleanup();
  }
});

test('shutdown drains an active stream before closing storage; duplicate close and failed listen release the directory', async () => {
  const context = await setup();
  try {
    const c = await (await context.call('/conversations', 'POST', {})).json();
    const response = await context.call(`/conversations/${c.id}/messages`, 'POST', {
      providerId: 'demo',
      model: '本地演示',
      content: '关闭验证',
    });
    const body = response.text();
    await Promise.all([context.runtime.close(), context.runtime.close()]);
    const events = await body;
    assert.match(events, /cancelled/);
    const reopened = await startServer({ port: 0, dataDir: context.directory });
    try {
      assert.equal(reopened.store.state.conversations[0].messages.at(-1)?.status, 'cancelled');
      const another = mkdtempSync(join(tmpdir(), 'chatworker-port-failure-'));
      try {
        await assert.rejects(startServer({ port: reopened.port, dataDir: another }));
        const retry = await startServer({ port: 0, dataDir: another });
        await retry.close();
      } finally {
        rmSync(another, { recursive: true, force: true });
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await context.cleanup();
  }
});
