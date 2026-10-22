import { reactive } from 'vue';
import { z } from 'zod';
import {
  blankDraft,
  copyDraft,
  sameDraft,
  draftContentSchema,
  draftIdentitySchema,
  draftSnapshotSchema,
  draftResultSchema,
  draftRecoverySchema,
  type DraftRecovery,
  type Draft,
  type DraftSnapshot,
} from '../../../../packages/contracts/drafts';

export interface DraftTransport {
  recoveries?(storeId: string, key: string): Promise<DraftRecovery[]>;
  archive?(storeId: string, key: string, draft: Draft, revision: number): Promise<void>;
  identity(): Promise<{ storeId: string; version: 2 }>;
  read(storeId: string, key: string): Promise<DraftSnapshot>;
  write(
    storeId: string,
    key: string,
    revision: number,
    draft: Draft,
    preservePrevious?: boolean,
  ): Promise<{ ok: boolean; current: DraftSnapshot }>;
}
const http: DraftTransport = {
  async recoveries(storeId, key) {
    const res = await fetch('/api/v1/drafts/' + encodeURIComponent(key) + '/recoveries', {
      headers: { 'X-ChatWorker': '1', 'X-ChatWorker-Store': storeId },
    });
    if (!res.ok) throw new Error('无法读取资料库中的草稿副本');
    return z.array(draftRecoverySchema).parse(await res.json());
  },
  async archive(storeId, key, draft, revision) {
    const res = await fetch('/api/v1/drafts/' + encodeURIComponent(key) + '/recoveries', {
      method: 'POST',
      headers: {
        'X-ChatWorker': '1',
        'X-ChatWorker-Store': storeId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ draft, revision }),
    });
    if (!res.ok) throw new Error('窗口版本副本尚未保存，请重试或先下载');
  },
  async identity() {
    const res = await fetch('/api/v1/drafts/identity', { headers: { 'X-ChatWorker': '1' } });
    if (!res.ok) throw new Error('无法连接草稿服务，请重试');
    return draftIdentitySchema.parse(await res.json());
  },
  async read(storeId, key) {
    const res = await fetch('/api/v1/drafts/' + encodeURIComponent(key), {
      headers: { 'X-ChatWorker': '1', 'X-ChatWorker-Store': storeId },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '无法读取草稿');
    return draftSnapshotSchema.parse(data);
  },
  async write(storeId, key, expectedRevision, draft, preservePrevious) {
    const res = await fetch('/api/v1/drafts/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: {
        'X-ChatWorker': '1',
        'X-ChatWorker-Store': storeId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision, draft, preservePrevious }),
    });
    const data = await res.json();
    if (!res.ok && !(res.status === 409 && data.ok === false))
      throw new Error(data.error || '草稿保存失败');
    return draftResultSchema.parse(data);
  },
};
const cacheSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().nonnegative(),
  draft: draftContentSchema,
});
export type DraftStatus = 'loading' | 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict';
interface Recovery {
  id: string;
  label: string;
  draft: Draft;
  revision: number;
}
export interface DraftEntry {
  draft: Draft;
  revision: number;
  epoch: number;
  loaded: boolean;
  dirty: boolean;
  preservePrevious: boolean;
  status: DraftStatus;
  warning: string;
  cacheWarning: string;
  remote?: DraftSnapshot;
  recoveries: Recovery[];
}
export interface DraftReceipt {
  draft: Draft;
  revision: number;
  epoch: number;
}
export class SyncedDraftStore {
  readonly records = reactive<Record<string, DraftEntry>>({});
  private storeId = '';
  private identityPending?: Promise<void>;
  private pending = new Map<string, Promise<void>>();
  private reads = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private clientId = crypto.randomUUID();
  private readonly transport: DraftTransport;
  constructor(
    private options: {
      storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>;
      transport?: DraftTransport;
      legacy?: (key: string) => Draft;
      debounceMs?: number;
    } = {},
  ) {
    this.transport = options.transport ?? http;
  }
  get(key: string): DraftEntry {
    if (!this.records[key])
      this.records[key] = {
        draft: blankDraft(),
        revision: 0,
        epoch: 0,
        loaded: false,
        dirty: false,
        preservePrevious: false,
        status: 'loading',
        warning: '',
        cacheWarning: '',
        recoveries: [],
      };
    return this.records[key];
  }
  private prefix(key: string) {
    return `chatworker:draft:v2:${this.storeId}:${encodeURIComponent(key)}:`;
  }
  private cache(key: string) {
    const e = this.get(key);
    try {
      if (!this.options.storage || !this.storeId) throw new Error('cache unavailable');
      this.options.storage.setItem(
        this.prefix(key) + this.clientId,
        JSON.stringify({ version: 2, revision: e.revision, draft: copyDraft(e.draft) }),
      );
      e.cacheWarning = '';
    } catch {
      e.cacheWarning = '本窗口缓存不可用；保存到资料库前请勿关闭页面。';
    }
  }
  private removeCache(key: string) {
    try {
      this.options.storage?.removeItem(this.prefix(key) + this.clientId);
    } catch {
      /* Server copy remains authoritative. */
    }
  }
  private recoveries(key: string) {
    const e = this.get(key);
    const candidates: Recovery[] = [...e.recoveries];
    try {
      const storage = this.options.storage;
      for (let i = 0; storage && i < storage.length; i++) {
        const id = storage.key(i)!;
        if (!id.startsWith(this.prefix(key))) continue;
        try {
          const cached = cacheSchema.parse(JSON.parse(storage.getItem(id)!));
          if (
            !sameDraft(cached.draft, e.draft) &&
            !candidates.some((c) => sameDraft(c.draft, cached.draft))
          )
            candidates.push({ id, label: '未保存的窗口副本', ...cached });
        } catch {
          e.cacheWarning = '部分旧缓存无法读取，原缓存已保留。';
        }
      }
      const legacy = this.options.legacy?.(key);
      if (
        legacy &&
        (legacy.text || legacy.attachments.length) &&
        !sameDraft(legacy, e.draft) &&
        !candidates.some((c) => sameDraft(c.draft, legacy))
      )
        candidates.push({
          id: 'legacy',
          label: '此地址的旧版草稿',
          draft: copyDraft(legacy),
          revision: e.revision,
        });
    } catch {
      e.cacheWarning = '无法读取窗口缓存，已保存的资料库草稿仍可使用。';
    }
    e.recoveries = candidates;
  }
  private async identity() {
    if (this.storeId) return;
    this.identityPending ??= this.transport
      .identity()
      .then((identity) => {
        this.storeId = draftIdentitySchema.parse(identity).storeId;
      })
      .finally(() => {
        this.identityPending = undefined;
      });
    await this.identityPending;
  }
  async open(key: string) {
    const e = this.get(key);
    try {
      await this.identity();
    } catch (error) {
      e.status = 'offline';
      e.warning = (error as Error).message;
      return;
    }
    await this.refresh(key);
  }
  async refresh(key: string) {
    if (!this.storeId) return this.open(key);
    if (this.pending.has(key)) return;
    if (this.reads.has(key)) return this.reads.get(key);
    const e = this.get(key);
    const epoch = e.epoch,
      revision = e.revision;
    const task = (async () => {
      try {
        const [remote, copies] = await Promise.all([
          this.transport.read(this.storeId, key),
          this.transport.recoveries?.(this.storeId, key) ?? [],
        ]);
        // A write or user choice started while the read was in flight: its response owns state.
        if (this.pending.has(key) || epoch !== e.epoch || revision !== e.revision) return;
        if (e.dirty) {
          if (remote.revision !== e.revision) {
            e.remote = remote;
            e.status = 'conflict';
          }
        } else {
          e.draft = copyDraft(remote.draft);
          e.revision = remote.revision;
          e.status = 'saved';
          e.remote = undefined;
        }
        e.loaded = true;
        e.warning = '';
        for (const c of copies)
          if (!e.recoveries.some((r) => sameDraft(r.draft, c.draft)))
            e.recoveries.push({
              id: 'server:' + c.id,
              label: '资料库中的版本副本',
              draft: copyDraft(c.draft),
              revision: c.revision,
            });
        this.recoveries(key);
      } catch (error) {
        if (this.pending.has(key) || epoch !== e.epoch || revision !== e.revision) return;
        e.status = e.remote ? 'conflict' : 'offline';
        e.warning = (error as Error).message;
      }
    })().finally(() => {
      this.reads.delete(key);
    });
    this.reads.set(key, task);
    return task;
  }
  set(key: string, draft: Draft) {
    const e = this.get(key);
    if (!e.loaded) return;
    e.draft = copyDraft(draftContentSchema.parse(draft));
    e.epoch++;
    e.dirty = true;
    e.status = e.remote ? 'conflict' : 'dirty';
    e.warning = '';
    this.cache(key);
    if (!e.remote) this.schedule(key);
  }
  private schedule(key: string) {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.flush(key);
      }, this.options.debounceMs ?? 400),
    );
  }
  async flush(key: string): Promise<DraftReceipt | undefined> {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (this.pending.has(key)) {
      await this.pending.get(key);
      return this.flush(key);
    }
    const e = this.get(key);
    if (!e.loaded || e.remote) return;
    if (!e.dirty) return { draft: copyDraft(e.draft), revision: e.revision, epoch: e.epoch };
    const task = (async () => {
      // Edits made during a save are serialized with the new revision, never lost to its response.
      while (e.dirty && !e.remote) {
        const sent = copyDraft(e.draft),
          epoch = e.epoch;
        e.status = 'saving';
        try {
          const result = await this.transport.write(
            this.storeId,
            key,
            e.revision,
            sent,
            e.preservePrevious,
          );
          if (!result.ok) {
            e.remote = result.current;
            e.status = 'conflict';
            this.cache(key);
            break;
          }
          e.revision = result.current.revision;
          e.preservePrevious = false;
          e.warning = '';
          if (e.epoch === epoch) {
            e.dirty = false;
            e.status = 'saved';
            e.cacheWarning = '';
            this.removeCache(key);
          } else {
            e.status = 'dirty';
            this.cache(key);
          }
        } catch (error) {
          e.status = 'offline';
          e.warning = (error as Error).message;
          this.cache(key);
          break;
        }
      }
    })().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, task);
    await task;
    if (!e.dirty && !e.remote)
      return { draft: copyDraft(e.draft), revision: e.revision, epoch: e.epoch };
  }
  clear(key: string) {
    this.set(key, blankDraft());
    return this.flush(key);
  }
  async clearIfUnchanged(key: string, receipt: DraftReceipt) {
    const e = this.get(key);
    if (
      e.epoch !== receipt.epoch ||
      e.revision !== receipt.revision ||
      !sameDraft(e.draft, receipt.draft)
    )
      return;
    return this.clear(key);
  }
  async move(from: string, to: string, receipt: DraftReceipt): Promise<DraftReceipt | undefined> {
    await this.open(to);
    const target = this.get(to);
    if (!target.loaded || target.dirty || target.draft.text || target.draft.attachments.length)
      return;
    this.set(to, receipt.draft);
    const saved = await this.flush(to);
    if (saved) await this.clearIfUnchanged(from, receipt);
    return saved;
  }
  async keepLocal(key: string) {
    const e = this.get(key);
    if (!e.remote) return;
    // A second concurrent edit can still reject this choice; never force an overwrite.
    this.archive(key, e.remote.draft, e.remote.revision, '选择前的已保存版本');
    e.revision = e.remote.revision;
    e.remote = undefined;
    e.epoch++;
    e.dirty = true;
    e.preservePrevious = true;
    this.cache(key);
    return this.flush(key);
  }
  async useRemote(key: string) {
    const e = this.get(key);
    if (!e.remote) return;
    const epoch = e.epoch;
    try {
      await this.transport.archive?.(this.storeId, key, copyDraft(e.draft), e.revision);
    } catch (error) {
      e.warning = (error as Error).message;
      return;
    }
    if (e.epoch !== epoch || !e.remote) return;
    this.archive(key, e.draft, e.revision, '选择前的窗口版本');
    e.draft = copyDraft(e.remote.draft);
    e.revision = e.remote.revision;
    e.remote = undefined;
    e.epoch++;
    e.dirty = false;
    e.status = 'saved';
    e.warning = '';
    this.removeCache(key);
  }
  private archive(key: string, draft: Draft, revision: number, label: string) {
    const id = this.prefix(key) + crypto.randomUUID();
    this.get(key).recoveries.push({ id, draft: copyDraft(draft), revision, label });
    try {
      if (!this.options.storage) throw new Error('cache unavailable');
      this.options.storage.setItem(
        id,
        JSON.stringify({ version: 2, revision, draft: copyDraft(draft) }),
      );
    } catch {
      this.get(key).cacheWarning = '版本副本仅保留在当前窗口，请先下载再关闭。';
    }
  }
  recover(key: string, id: string) {
    const e = this.get(key),
      recovery = e.recoveries.find((r) => r.id === id);
    if (!e.loaded || !recovery || this.pending.has(key)) return;
    // Importing a legacy/cache copy is an explicit choice, and still requires conflict resolution.
    const remote = e.remote ?? {
      key,
      revision: e.revision,
      updatedAt: null,
      draft: copyDraft(e.draft),
    };
    if (e.dirty && !sameDraft(e.draft, recovery.draft))
      this.archive(key, e.draft, e.revision, '切换副本前的窗口版本');
    e.draft = copyDraft(recovery.draft);
    e.epoch++;
    e.dirty = true;
    e.remote = remote;
    e.status = 'conflict';
    this.cache(key);
  }
  snapshot(key: string) {
    return copyDraft(this.get(key).draft);
  }
  async flushAll() {
    await Promise.all(Object.keys(this.records).map((key) => this.flush(key)));
  }
  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
