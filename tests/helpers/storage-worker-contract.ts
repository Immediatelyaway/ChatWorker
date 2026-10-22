import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Storage } from '../../apps/server/src/storage.js';
import { initialState } from '../../packages/contracts/state.js';

export async function verifyStorageWorkerContract(directory: string) {
  const data = join(directory, 'worker-data');
  mkdirSync(data);
  const original = initialState();
  original.projects.push({ id: 'p', name: '升级前', description: '保存' });
  const legacy = JSON.stringify(original);
  writeFileSync(join(data, 'state.json'), legacy);
  await assert.rejects(Storage.open(data), { code: 'LEGACY_MIGRATION_REQUIRED' });
  const store = await Storage.open(data, { migrateLegacy: true });
  const id = store.storeId;
  try {
    await assert.rejects(Storage.open(data), { code: 'STORE_BUSY' });
    await store.update((state) => {
      state.projects[0].name = '升级后';
    });
    assert.equal(store.state.projects[0].name, '升级后');
    await store.writeDraft('new:work:p', {
      expectedRevision: 0,
      draft: { text: '重启草稿', attachments: [{ name: '资料.md', content: '跨启动附件' }] },
    });
  } finally {
    await store.close();
  }
  const reopened = await Storage.open(data);
  try {
    assert.equal(reopened.storeId, id);
    assert.equal((await reopened.readDraft('new:work:p')).draft.text, '重启草稿');
    assert.equal(
      (await reopened.readDraft('new:work:p')).draft.attachments[0].content,
      '跨启动附件',
    );
    assert.equal(
      (
        await reopened.writeDraft('new:work:p', {
          expectedRevision: 0,
          draft: { text: '过期覆盖', attachments: [] },
        })
      ).ok,
      false,
    );
    assert.equal(reopened.state.projects[0].name, '升级后');
    assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), legacy);
  } finally {
    await reopened.close();
  }
  return [
    'worker-start',
    'legacy-upgrade',
    'directory-lock',
    'transaction',
    'worker-close',
    'reopen',
    'stable-store-id',
    'draft-restart-and-cas',
  ];
}
