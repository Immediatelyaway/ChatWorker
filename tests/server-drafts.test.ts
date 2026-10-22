import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { startServer } from '../apps/server/src/index.js';
import { Storage } from '../apps/server/src/storage.js';
import { DATABASE_VERSION } from '../packages/contracts/versions.js';

const draft = (text: string) => ({
  text,
  attachments: [{ name: '资料.md', content: '附件内容 🐈' }],
});
test('draft CAS preserves both writers, refuses stale clears and restores across server ports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatworker-drafts-api-'));
  let runtime = await startServer({ port: 0, dataDir: directory });
  const storeId = runtime.store.storeId;
  const call = (path: string, method = 'GET', body?: unknown, identity = storeId) =>
    fetch(`http://127.0.0.1:${runtime.port}/api${path}`, {
      method,
      headers: {
        'X-ChatWorker': '1',
        'X-ChatWorker-Store': identity,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const identity = await (await call('/v1/drafts/identity')).json();
    assert.deepEqual(identity, { storeId, version: 2 });
    const url = '/v1/drafts/' + encodeURIComponent('new:work:');
    const initial = await (await call(url)).json();
    assert.equal(initial.revision, 0);
    const writes = await Promise.all(
      ['窗口 A', '窗口 B'].map((text) =>
        call(url, 'PUT', { expectedRevision: 0, draft: draft(text) }),
      ),
    );
    assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
    const winner = await (await call(url)).json();
    assert.equal(winner.revision, 1);
    const conflict = await (
      await call(url, 'PUT', { expectedRevision: 0, draft: { text: '', attachments: [] } })
    ).json();
    assert.equal(conflict.ok, false);
    assert.deepEqual(conflict.current, winner);
    assert.equal(
      (
        await call(
          url,
          'PUT',
          { expectedRevision: 1, draft: draft('wrong store') },
          crypto.randomUUID(),
        )
      ).status,
      409,
    );
    assert.deepEqual(await (await call(url)).json(), winner);
    assert.equal(
      (await call(url, 'PUT', { expectedRevision: -1, draft: draft('invalid') })).status,
      400,
    );
    assert.equal(
      (await call('/v1/drafts/' + encodeURIComponent('conversation:missing'))).status,
      404,
    );
    await runtime.close();
    runtime = await startServer({ port: 0, dataDir: directory });
    assert.equal(runtime.store.storeId, storeId);
    assert.deepEqual(await (await call(url)).json(), winner);
    const recoveries = await (await call(url + '/recoveries')).json();
    assert.equal(recoveries.length, 1);
    assert.notEqual(recoveries[0].draft.text, winner.draft.text);
    const cleared = await (
      await call(url, 'PUT', { expectedRevision: 1, draft: { text: '', attachments: [] } })
    ).json();
    assert.equal(cleared.current.revision, 2);
    assert.equal(
      (await call(url, 'PUT', { expectedRevision: 0, draft: draft('stale resurrection') })).status,
      409,
    );
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('history transactions preserve drafts; deleted contexts clear content and cannot resurrect it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatworker-drafts-delete-'));
  const store = await Storage.open(directory);
  try {
    await store.update((state) => {
      state.projects.push({ id: 'p', name: '项目', description: '' });
    });
    await store.writeDraft('new:chat:p', { expectedRevision: 0, draft: draft('项目草稿') });
    await store.writeDraft('new:work:', { expectedRevision: 0, draft: draft('独立草稿') });
    await store.archiveDraft('new:chat:p', { revision: 1, draft: draft('另一个窗口') });
    await store.archiveDraft('new:chat:p', { revision: 1, draft: draft('另一个窗口') });
    assert.equal((await store.listDraftRecoveries('new:chat:p')).length, 1);
    await store.update((state) => {
      state.preferences.theme = 'dark';
    });
    assert.equal((await store.readDraft('new:chat:p')).draft.text, '项目草稿');
    await store.writeDraft('new:chat:p', {
      expectedRevision: 1,
      draft: draft('显式选择新稿'),
      preservePrevious: true,
    });
    assert.equal((await store.listDraftRecoveries('new:chat:p')).length, 2);
    await store.update((state) => {
      state.projects = [];
    });
    await assert.rejects(
      store.writeDraft('new:chat:p', { expectedRevision: 1, draft: draft('已删除') }),
      { code: 'DRAFT_TARGET_MISSING' },
    );
    assert.equal((await store.readDraft('new:work:')).draft.text, '独立草稿');
    const db = new DatabaseSync(join(directory, 'state.sqlite'));
    try {
      assert.deepEqual(
        {
          ...db
            .prepare('SELECT text,attachments_json,revision FROM drafts WHERE owner_key=?')
            .get('new:chat:p'),
        },
        { text: '', attachments_json: '[]', revision: 3 },
      );
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v1 SQLite upgrades with an exact backup and stable identity; failed schema migration rolls back', async () => {
  for (const fail of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'chatworker-drafts-upgrade-'));
    try {
      const original = await Storage.open(directory);
      const id = original.storeId;
      await original.update((s) => {
        s.projects.push({ id: 'keep', name: '已有项目', description: '保留' });
      });
      await original.close();
      const file = join(directory, 'state.sqlite');
      const old = new DatabaseSync(file);
      old.exec('DROP TABLE drafts; DROP TABLE draft_recoveries; PRAGMA user_version=1;');
      if (fail) old.exec('CREATE TABLE drafts (conflict TEXT);');
      old.close();
      const bytes = readFileSync(file);
      if (fail) {
        await assert.rejects(Storage.open(directory));
        const check = new DatabaseSync(file);
        try {
          assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 1);
        } finally {
          check.close();
        }
      } else {
        const upgraded = await Storage.open(directory);
        try {
          assert.equal(upgraded.storeId, id);
          assert.equal(upgraded.state.projects[0].name, '已有项目');
          assert.equal((await upgraded.readDraft('new:chat:')).revision, 0);
          const check = new DatabaseSync(file);
          try {
            assert.equal(
              check.prepare('PRAGMA user_version').get()?.user_version,
              DATABASE_VERSION,
            );
          } finally {
            check.close();
          }
        } finally {
          await upgraded.close();
        }
      }
      const backup = readdirSync(directory).find((n) => n.startsWith('state.sqlite.backup-v1-'))!;
      assert.equal(
        backup,
        'state.sqlite.backup-v1-' + createHash('sha256').update(bytes).digest('hex'),
      );
      assert.deepEqual(readFileSync(join(directory, backup)), bytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('draft write and recovery failures roll back together and later writes can succeed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatworker-drafts-rollback-'));
  const store = await Storage.open(directory);
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  try {
    const key = 'new:work:';
    const original = await store.writeDraft(key, { expectedRevision: 0, draft: draft('原稿') });
    db.exec(`CREATE TRIGGER reject_draft BEFORE UPDATE ON drafts
      BEGIN SELECT RAISE(ABORT, 'simulated draft write failure'); END;`);
    await assert.rejects(
      store.writeDraft(key, {
        expectedRevision: 1,
        draft: draft('新稿'),
        preservePrevious: true,
      }),
    );
    assert.deepEqual(await store.readDraft(key), original.current);
    assert.equal((await store.listDraftRecoveries(key)).length, 0);
    db.exec('DROP TRIGGER reject_draft;');
    db.exec(`CREATE TRIGGER reject_recovery BEFORE INSERT ON draft_recoveries
      BEGIN SELECT RAISE(ABORT, 'simulated recovery write failure'); END;`);
    await assert.rejects(
      store.writeDraft(key, {
        expectedRevision: 0,
        draft: draft('冲突副本'),
      }),
    );
    await assert.rejects(store.archiveDraft(key, { revision: 1, draft: draft('恢复副本') }));
    assert.deepEqual(await store.readDraft(key), original.current);
    db.exec('DROP TRIGGER reject_recovery;');
    const next = await store.writeDraft(key, {
      expectedRevision: 1,
      draft: draft('新稿'),
      preservePrevious: true,
    });
    assert.equal(next.ok, true);
    assert.equal(next.current.revision, 2);
    assert.equal((await store.listDraftRecoveries(key))[0].draft.text, '原稿');
  } finally {
    db.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
