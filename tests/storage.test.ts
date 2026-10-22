import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../apps/server/src/storage.js';
import { initialState } from '../apps/server/src/state-schema.js';
import { exportBackup, importBackup } from '../apps/server/src/backup.js';
import { JsonSnapshotRepository } from '../packages/storage/json-snapshot-repository.js';
import type { StateRepository } from '../packages/storage/state-repository.js';
import type { State } from '../packages/shared/types.js';

test('storage boundary keeps validation and restart recovery above file IO', async () => {
  const original = initialState();
  original.conversations.push({
    id: 'c',
    title: '未完成会话',
    projectId: null,
    mode: 'chat',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activities: [],
    archived: false,
    messages: [
      {
        id: 'm',
        role: 'assistant',
        content: '部分内容',
        status: 'streaming',
        createdAt: new Date().toISOString(),
      },
    ],
  });
  let saved: State | undefined;
  const repository: StateRepository = {
    archiveDraft: async () => {},
    listDraftRecoveries: async () => [],
    readDraft: async () => {
      throw new Error('not used');
    },
    writeDraft: async () => {
      throw new Error('not used');
    },
    storeId: crypto.randomUUID(),
    close: async () => {},
    load: async () => original,
    save: async (value) => {
      saved = structuredClone(value);
    },
  };
  const store = await Storage.create(repository);
  assert.equal(saved!.conversations[0].messages[0].status, 'failed');
  assert.equal(saved!.conversations[0].activities.length, 1);
  assert.equal(original.conversations[0].messages[0].status, 'streaming');
  const snapshot = structuredClone(store.state);
  const next = structuredClone(store.state);
  next.projects.push({ id: 'p', name: '新项目', description: '' });
  repository.save = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(store.replace(next), /disk full/);
  assert.deepEqual(store.state, snapshot);
  await assert.rejects(
    store.update((state) => {
      state.projects.push({ id: 'p', name: '失败', description: '' });
    }),
    /disk full/,
  );
  assert.deepEqual(store.state, snapshot);
  await assert.rejects(Storage.create(repository), /disk full/);
  await store.close();
  for (const invalid of [null, {}, { ...initialState(), schemaVersion: 99 }]) {
    let writes = 0;
    await assert.rejects(
      Storage.create({
        archiveDraft: async () => {},
        listDraftRecoveries: async () => [],
        readDraft: async () => {
          throw new Error('not used');
        },
        writeDraft: async () => {
          throw new Error('not used');
        },
        storeId: crypto.randomUUID(),
        load: async () => invalid,
        save: async () => {
          writes++;
        },
        close: async () => {},
      }),
    );
    assert.equal(writes, 0);
  }
});

test('JSON repository reads without writing and failed serialization preserves the previous snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-json-boundary-'));
  const file = join(dir, 'state.json');
  try {
    const repository = new JsonSnapshotRepository<unknown>(dir);
    assert.equal(repository.load(), undefined);
    repository.save({ text: '保存内容' });
    const before = readFileSync(file, 'utf8');
    assert.deepEqual(repository.load(), { text: '保存内容' });
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.throws(() => repository.save({ invalid: 1n }));
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup imports independent copies and repairs interrupted messages without importing configuration', () => {
  const state = initialState();
  state.projects.push({ id: 'p', name: '项目', description: '描述' });
  state.conversations.push({
    id: 'c',
    title: '会话',
    projectId: 'p',
    mode: 'work',
    archived: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activities: [],
    messages: [
      {
        id: 'm',
        role: 'assistant',
        content: '部分内容',
        status: 'streaming',
        createdAt: new Date().toISOString(),
        attachments: [{ name: 'a.txt', content: '资料' }],
      },
    ],
  });
  const backup = exportBackup(state);
  assert.ok(!('providers' in backup.data));
  const imported = importBackup(state, backup);
  assert.equal(state.conversations.length, 1);
  assert.equal(imported.conversations.length, 2);
  const copy = imported.conversations[0];
  assert.notEqual(copy.id, 'c');
  assert.equal(copy.projectId, imported.projects[1].id);
  assert.equal(copy.messages[0].status, 'failed');
  assert.equal(copy.messages[0].attachments![0].content, '资料');
  assert.equal(copy.archived, true);
  assert.deepEqual(imported.preferences, state.preferences);
  assert.deepEqual(imported.providers, state.providers);
  assert.throws(() => importBackup(state, { ...backup, version: 2 }));
  assert.throws(() => importBackup(state, { ...backup, data: { ...backup.data, projects: [] } }));
  assert.throws(() =>
    importBackup(state, { ...backup, data: { ...backup.data, conversations: [copy, copy] } }),
  );
});
