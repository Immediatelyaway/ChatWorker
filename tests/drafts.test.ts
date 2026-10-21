import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftStore, draftKey } from '../apps/web/src/composables/drafts.js';
function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
const sample = {
  text: '未发送的问题',
  attachments: [{ name: 'a.ts', content: 'const value = 42;' }],
};

test('drafts restore text and attachments while isolating conversation/project/mode', () => {
  const storage = memory();
  const store = new DraftStore(storage);
  const key = draftKey('a', '', 'chat');
  store.set(key, sample);
  assert.deepEqual(new DraftStore(storage).snapshot(key), sample);
  for (const other of [
    draftKey('b', '', 'chat'),
    draftKey('', 'p', 'chat'),
    draftKey('', 'p', 'work'),
  ]) {
    assert.equal(store.get(other).text, '');
    store.set(other, { text: other, attachments: [] });
  }
  assert.deepEqual(store.snapshot(key), sample);
  const snapshot = store.snapshot(key);
  snapshot.attachments[0].content = 'changed';
  assert.equal(store.get(key).attachments[0].content, sample.attachments[0].content);
});

test('moving new-chat drafts and acknowledging sends never clears a newer draft', () => {
  const storage = memory();
  const store = new DraftStore(storage);
  const oldKey = draftKey('', '', 'work'),
    key = draftKey('created', '', 'work');
  store.set(oldKey, sample);
  store.move(oldKey, key);
  assert.equal(new DraftStore(storage).get(oldKey).text, '');
  assert.deepEqual(new DraftStore(storage).snapshot(key), sample);
  store.set(key, { text: '下一条消息', attachments: [] });
  store.clearIfUnchanged(key, sample);
  assert.equal(store.get(key).text, '下一条消息');
  store.clearIfUnchanged(key, store.snapshot(key));
  assert.equal(new DraftStore(storage).get(key).text, '');
});

test('quota failures preserve in-memory drafts and corrupt data is not overwritten on read', () => {
  const storage = memory();
  const store = new DraftStore({
    ...storage,
    setItem: () => {
      throw new Error('quota');
    },
  });
  store.set('key', sample);
  assert.deepEqual(store.snapshot('key'), sample);
  assert.match(store.warnings.key, /内存/);
  const key = 'chatworker:draft:v1:broken';
  for (const raw of [
    '{broken',
    JSON.stringify({ version: 2, ...sample }),
    JSON.stringify({ version: 1, text: 'x', attachments: [{}] }),
  ]) {
    storage.values.set(key, raw);
    const next = new DraftStore(storage);
    assert.equal(next.get('broken').text, '');
    assert.match(next.warnings.broken, /无法读取/);
    assert.equal(storage.values.get(key), raw);
  }
});
