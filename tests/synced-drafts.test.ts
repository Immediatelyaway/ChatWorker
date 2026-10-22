import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SyncedDraftStore,
  type DraftTransport,
} from '../apps/web/src/composables/synced-drafts.js';
import { blankDraft, type DraftSnapshot } from '../packages/contracts/drafts.js';

class MemoryStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}
function fixture() {
  const storeId = crypto.randomUUID();
  const records = new Map<string, DraftSnapshot>();
  const read = (key: string): DraftSnapshot =>
    structuredClone(records.get(key) ?? { key, revision: 0, updatedAt: null, draft: blankDraft() });
  const transport: DraftTransport = {
    identity: async () => ({ storeId, version: 2 }),
    read: async (_id, key) => read(key),
    write: async (_id, key, revision, draft) => {
      const current = read(key);
      if (current.revision !== revision) return { ok: false, current };
      const next = {
        key,
        revision: revision + 1,
        updatedAt: new Date().toISOString(),
        draft: structuredClone(draft),
      };
      records.set(key, next);
      return { ok: true, current: structuredClone(next) };
    },
  };
  const clients: SyncedDraftStore[] = [];
  const client = (options: ConstructorParameters<typeof SyncedDraftStore>[0] = {}) => {
    const c = new SyncedDraftStore({
      transport,
      storage: new MemoryStorage(),
      debounceMs: 100000,
      ...options,
    });
    clients.push(c);
    return c;
  };
  return {
    storeId,
    transport,
    records,
    read,
    client,
    cleanup: () => clients.forEach((c) => c.dispose()),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const key = 'new:work:';
const content = (text: string) => ({ text, attachments: [] });

test('two windows preserve conflicting content; explicit choices use CAS and stale acknowledgement cannot clear newer edits', async () => {
  const f = fixture();
  const a = f.client(),
    b = f.client();
  try {
    await Promise.all([a.open(key), b.open(key)]);
    a.set(key, content('版本 A'));
    const receipt = (await a.flush(key))!;
    b.set(key, content('版本 B'));
    assert.equal(await b.flush(key), undefined);
    assert.equal(b.get(key).status, 'conflict');
    assert.equal(b.get(key).draft.text, '版本 B');
    assert.equal(b.get(key).remote?.draft.text, '版本 A');
    await b.keepLocal(key);
    assert.equal(f.read(key).draft.text, '版本 B');
    assert.ok(b.get(key).recoveries.some((r) => r.draft.text === '版本 A'));
    await a.clearIfUnchanged(key, receipt);
    assert.equal(f.read(key).draft.text, '版本 B');
    assert.equal(a.get(key).status, 'conflict');
    await a.useRemote(key);
    assert.equal(a.get(key).draft.text, '版本 B');
    const latest = (await a.flush(key))!;
    a.set(key, content('新输入'));
    a.set(key, content('版本 B'));
    await a.clearIfUnchanged(key, latest);
    assert.equal(
      a.get(key).draft.text,
      '版本 B',
      'same text after new edits is still a newer local generation',
    );
  } finally {
    f.cleanup();
  }
});

test('editing during a pending write is serialized after its revision without losing newer input', async () => {
  const f = fixture(),
    gate = deferred<void>(),
    entered = deferred<void>();
  const write = f.transport.write;
  let calls = 0;
  f.transport.write = async (...args) => {
    calls++;
    if (calls === 1) {
      entered.resolve();
      await gate.promise;
    }
    return write(...args);
  };
  const c = f.client();
  try {
    await c.open(key);
    c.set(key, content('第一稿'));
    const pending = c.flush(key);
    await entered.promise;
    c.set(key, { text: '第二稿', attachments: [{ name: 'a.md', content: '附件' }] });
    gate.resolve();
    const receipt = await pending;
    assert.equal(calls, 2);
    assert.equal(receipt?.revision, 2);
    assert.equal(f.read(key).draft.text, '第二稿');
    assert.equal(c.get(key).status, 'saved');
  } finally {
    gate.resolve();
    f.cleanup();
  }
});

test('an old read response cannot overwrite a newer completed save', async () => {
  const f = fixture(),
    c = f.client(),
    gate = deferred<DraftSnapshot>();
  try {
    await c.open(key);
    f.transport.read = async () => gate.promise;
    const refresh = c.refresh(key);
    c.set(key, content('更新后的内容'));
    await c.flush(key);
    gate.resolve({ key, revision: 0, updatedAt: null, draft: blankDraft() });
    await refresh;
    assert.equal(c.get(key).revision, 1);
    assert.equal(c.get(key).draft.text, '更新后的内容');
  } finally {
    gate.resolve(f.read(key));
    f.cleanup();
  }
});

test('a stale read failure cannot replace the status of a later successful save', async () => {
  const f = fixture(),
    c = f.client(),
    gate = deferred<void>();
  try {
    await c.open(key);
    f.transport.read = async () => {
      await gate.promise;
      throw new Error('old read failed');
    };
    const refresh = c.refresh(key);
    c.set(key, content('已保存的新稿'));
    await c.flush(key);
    gate.resolve();
    await refresh;
    assert.equal(c.get(key).status, 'saved');
    assert.equal(c.get(key).warning, '');
    assert.equal(c.get(key).draft.text, '已保存的新稿');
  } finally {
    gate.resolve();
    f.cleanup();
  }
});

test('lost save response remains recoverable; retry cannot silently overwrite another window', async () => {
  const f = fixture(),
    cache = new MemoryStorage(),
    c = f.client({ storage: cache });
  const write = f.transport.write;
  try {
    await c.open(key);
    f.transport.write = async (...args) => {
      await write(...args);
      throw new Error('response lost');
    };
    c.set(key, content('已提交但响应丢失'));
    assert.equal(await c.flush(key), undefined);
    assert.equal(c.get(key).status, 'offline');
    assert.ok(cache.length > 0);
    f.transport.write = write;
    const other = f.client();
    await other.open(key);
    other.set(key, content('后来修改'));
    await other.flush(key);
    await c.flush(key);
    assert.equal(c.get(key).status, 'conflict');
    assert.equal(c.get(key).remote?.draft.text, '后来修改');
    assert.equal(c.get(key).draft.text, '已提交但响应丢失');
  } finally {
    f.cleanup();
  }
});

test('offline copies use separate window keys, are offered after reload, and are isolated by store identity', async () => {
  const f = fixture(),
    cache = new MemoryStorage();
  const a = f.client({ storage: cache }),
    b = f.client({ storage: cache });
  try {
    await Promise.all([a.open(key), b.open(key)]);
    a.set(key, content('窗口离线 A'));
    b.set(key, content('窗口离线 B'));
    assert.equal(cache.length, 2);
    const reload = f.client({ storage: cache });
    await reload.open(key);
    assert.equal(reload.get(key).draft.text, '');
    assert.equal(reload.get(key).recoveries.length, 2);
    reload.recover(key, reload.get(key).recoveries[0].id);
    assert.equal(reload.get(key).status, 'conflict');
    reload.set(key, content('比较期间继续编辑的第三稿'));
    reload.recover(key, reload.get(key).recoveries[1].id);
    assert.ok(reload.get(key).recoveries.some((r) => r.draft.text === '比较期间继续编辑的第三稿'));
    assert.equal(f.read(key).revision, 0, 'recovery is a choice, not an automatic overwrite');
    const separate = f.client({
      storage: cache,
      transport: {
        ...f.transport,
        identity: async () => ({ storeId: crypto.randomUUID(), version: 2 }),
      },
    });
    await separate.open(key);
    assert.equal(separate.get(key).recoveries.length, 0);
  } finally {
    f.cleanup();
  }
});

test('legacy drafts require explicit comparison; failed move retains the saved source', async () => {
  const f = fixture(),
    c = f.client({ legacy: () => content('旧草稿') });
  try {
    await c.open(key);
    assert.equal(f.read(key).revision, 0);
    assert.equal(c.get(key).recoveries[0].label, '此地址的旧版草稿');
    c.recover(key, 'legacy');
    await c.keepLocal(key);
    const receipt = (await c.flush(key))!;
    const write = f.transport.write;
    f.transport.write = async (...args) => {
      if (args[1] === 'conversation:new') throw new Error('disk failure');
      return write(...args);
    };
    assert.equal(await c.move(key, 'conversation:new', receipt), undefined);
    assert.equal(f.read(key).draft.text, '旧草稿');
    assert.equal(c.get('conversation:new').draft.text, '旧草稿');
    f.transport.write = write;
    await c.flush('conversation:new');
    c.set(key, content('在发送中输入新内容'));
    await c.clearIfUnchanged(key, receipt);
    assert.equal(c.get(key).draft.text, '在发送中输入新内容');
  } finally {
    f.cleanup();
  }
});

test('cache quota errors do not prevent server saving and unsaved conflict copies remain in memory', async () => {
  const f = fixture(),
    cache = new MemoryStorage();
  cache.setItem = () => {
    throw new Error('quota');
  };
  const c = f.client({ storage: cache });
  try {
    await c.open(key);
    c.set(key, content('可保存'));
    assert.match(c.get(key).cacheWarning, /缓存不可用/);
    await c.flush(key);
    assert.equal(c.get(key).status, 'saved');
    assert.equal(c.get(key).cacheWarning, '');
    const other = f.client();
    await other.open(key);
    other.set(key, content('其他窗口'));
    await other.flush(key);
    c.set(key, content('本窗口'));
    await c.flush(key);
    await c.useRemote(key);
    assert.ok(c.get(key).recoveries.some((r) => r.draft.text === '本窗口'));
    assert.match(c.get(key).cacheWarning, /仅保留/);
  } finally {
    f.cleanup();
  }
});
