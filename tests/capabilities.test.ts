import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.js';
import { describeCapabilities } from '../apps/server/src/capabilities.js';
import { memorySecrets } from '../apps/server/src/storage.js';
import { decodeCapabilities } from '../packages/contracts/capabilities.js';
import { createCapabilitiesClient } from '../apps/web/src/composables/capabilities.js';

const sample = () => describeCapabilities({ desktop: false, persistentKeys: false });

test('capability decoding rejects incompatible or incomplete responses and strips unrelated fields', () => {
  const fixture = sample();
  assert.throws(() => decodeCapabilities({ ...fixture, contractVersion: 99 }), /版本不兼容/);
  assert.throws(() => decodeCapabilities({ ...fixture, features: {} }), /不完整/);
  assert.throws(() => decodeCapabilities({ ...fixture, execution: { engine: 'agent' } }), /不完整/);
  assert.throws(
    () => decodeCapabilities({ ...fixture, limits: { ...fixture.limits, inputCharacters: -1 } }),
    /不完整/,
  );
  assert.throws(() => decodeCapabilities(null), /不完整/);
  const decoded = decodeCapabilities({ ...fixture, apiKey: 'must-not-be-retained' });
  assert.ok(!('apiKey' in decoded));
  assert.equal(decoded.features.terminal.status, 'unavailable');
  assert.equal(decoded.features.workspaceFiles.status, 'unavailable');
  assert.equal(decoded.features.runRecovery.status, 'unavailable');
});

test('capabilities reflect Web and desktop runtime without leaking or changing local data', async () => {
  for (const config of [
    { desktop: false, persistentKeys: false },
    { desktop: true, persistentKeys: true },
    { desktop: true, persistentKeys: false },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'chatworker-capabilities-'));
    const secrets = memorySecrets();
    secrets.persistent = config.persistentKeys;
    secrets.set('openai', 'test-only-secret-capability');
    const runtime = await startServer({ port: 0, dataDir: dir, desktop: config.desktop, secrets });
    const origin = `http://127.0.0.1:${runtime.port}`;
    try {
      await runtime.store.update((state) => {
        state.projects.push({
          id: 'private-id',
          name: 'private-project-marker',
          description: 'private-content-marker',
        });
      });
      const before = readFileSync(join(dir, 'state.sqlite'));
      const url = origin + '/api/v1/capabilities';
      const response = await fetch(url, { headers: { 'X-ChatWorker': '1' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const raw = await response.text();
      const info = decodeCapabilities(JSON.parse(raw));
      const manifest = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      );
      assert.equal(info.appVersion, manifest.version);
      assert.equal(info.environment, config.desktop ? 'desktop' : 'web');
      assert.equal(info.storage.keyPersistence, config.persistentKeys ? 'persistent' : 'memory');
      assert.equal(info.storage.stateVersion, runtime.store.state.schemaVersion);
      assert.equal(info.storage.history, 'sqlite');
      assert.equal(info.storage.databaseVersion, 4);
      const backup = await fetch(origin + '/api/backups', {
        headers: { 'X-ChatWorker': '1' },
      }).then((r) => r.json());
      assert.equal(info.storage.backupVersion, backup.version);
      assert.equal(info.storage.drafts, 'server-sqlite');
      assert.match(info.features.drafts.detail, /重启或端口变化/);
      assert.equal(info.execution.onDisconnect, 'cancel');
      assert.equal(info.execution.onRestart, 'mark-interrupted-failed');
      for (const privateValue of [
        'test-only-secret-capability',
        'private-project-marker',
        'private-content-marker',
        dir,
        'api.openai.com',
      ])
        assert.ok(!raw.includes(privateValue));
      assert.deepEqual(readFileSync(join(dir, 'state.sqlite')), before);
      assert.equal((await fetch(url)).status, 403);
      assert.equal(
        (
          await fetch(url, {
            headers: { 'X-ChatWorker': '1', Origin: 'https://untrusted.example' },
          })
        ).status,
        403,
      );
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('advertised input and attachment limits match the actual message API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-capability-limits-'));
  const runtime = await startServer({ port: 0, dataDir: dir });
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.port}/api${path}`, {
      method,
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const { limits } = decodeCapabilities(await (await call('/v1/capabilities')).json());
    const c = await (await call('/conversations', 'POST', {})).json();
    const base = { content: 'test', providerId: 'demo', model: '本地演示' };
    for (const override of [
      { content: 'x'.repeat(limits.inputCharacters + 1) },
      {
        attachments: Array.from({ length: limits.attachmentsPerMessage + 1 }, () => ({
          name: 'a.txt',
          content: 'x',
        })),
      },
      { attachments: [{ name: 'x'.repeat(limits.attachmentNameCharacters + 1), content: '' }] },
      { attachments: [{ name: 'a.txt', content: 'x'.repeat(limits.attachmentCharacters + 1) }] },
      {
        attachments: Array.from({ length: 3 }, () => ({
          name: 'a.txt',
          content: 'x'.repeat(limits.attachmentCharacters),
        })),
      },
    ]) {
      const response = await call(`/conversations/${c.id}/messages`, 'POST', {
        ...base,
        ...override,
      });
      assert.equal(response.status, 400);
      assert.equal(runtime.store.state.conversations[0].messages.length, 0);
    }
    const accepted = await call(`/conversations/${c.id}/messages`, 'POST', {
      ...base,
      content: 'x'.repeat(limits.inputCharacters),
      attachments: Array.from({ length: limits.attachmentsPerMessage }, () => ({
        name: 'a.txt',
        content: '',
      })),
    });
    assert.equal(accepted.status, 200);
    await call(`/conversations/${c.id}/cancel`, 'POST');
    await accepted.text();
    assert.equal(
      runtime.store.state.conversations[0].messages[0].content.length,
      limits.inputCharacters,
    );
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capability client clears stale success on failure and recovers without blocking chat state', async () => {
  let result = Response.json(sample());
  let offline = false;
  const client = createCapabilitiesClient(async () => {
    if (offline) throw new TypeError('Failed to fetch');
    return result;
  });
  await client.load();
  assert.equal(client.state.status, 'ready');
  assert.ok(client.state.data);
  offline = true;
  await client.load();
  assert.equal(client.state.data, null);
  assert.match(client.state.error, /无法连接本地服务/);
  offline = false;
  result = Response.json({}, { status: 404 });
  await client.load();
  assert.equal(client.state.status, 'error');
  assert.equal(client.state.data, null);
  assert.match(client.state.error, /更新并重启/);
  result = Response.json({ ...sample(), contractVersion: sample().contractVersion + 1 });
  await client.load();
  assert.match(client.state.error, /版本不兼容/);
  result = new Response('<html>old frontend</html>');
  await client.load();
  assert.match(client.state.error, /有效的运行信息/);
  result = Response.json(sample());
  await client.load();
  assert.equal(client.state.status, 'ready');
  assert.equal(client.state.error, '');
  client.dispose();
});

test('capability refresh is deduplicated and a disposed request cannot overwrite a new result', async () => {
  let resolveFirst!: (response: Response) => void;
  let calls = 0;
  let firstSignal!: AbortSignal;
  const client = createCapabilitiesClient((signal) => {
    calls++;
    if (calls === 1) {
      firstSignal = signal;
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Promise.resolve(Response.json(sample()));
  });
  const first = client.load();
  await client.load();
  assert.equal(calls, 1);
  client.dispose();
  assert.equal(firstSignal.aborted, true);
  await client.load();
  assert.equal(client.state.data?.environment, 'web');
  resolveFirst(Response.json(describeCapabilities({ desktop: true, persistentKeys: true })));
  await first;
  assert.equal(client.state.status, 'ready');
  assert.equal(client.state.data?.environment, 'web');
  client.dispose();
});
