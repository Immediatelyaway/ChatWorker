import type { LibraryQuery } from '../contracts/library.js';
import type {
  DraftWrite,
  DraftSnapshot,
  DraftResult,
  DraftRecovery,
  DraftCopy,
} from '../contracts/drafts.js';
import { Worker } from 'node:worker_threads';
import type { State } from '../shared/types.js';
import type { StateRepository } from './state-repository.js';

function remoteError(value: { message: string; code: string }) {
  return Object.assign(new Error(value.message), { code: value.code });
}

export class WorkerStateRepository implements StateRepository {
  storeId = '';
  private serial = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;
  private readonly ready: Promise<void>;

  private constructor(private readonly worker: Worker) {
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const fail = (error: Error) => {
      this.failure = error;
      readyReject(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on('message', (response) => {
      if ('ready' in response) {
        if (response.ready) {
          this.storeId = response.storeId;
          readyResolve();
        } else fail(remoteError(response.error));
        return;
      }
      const pending = this.pending.get(response.id);
      this.pending.delete(response.id);
      if (response.error) pending?.reject(remoteError(response.error));
      else pending?.resolve(response.value);
    });
    worker.on('error', fail);
    worker.on('messageerror', fail);
    this.exited = new Promise((resolve) =>
      worker.once('exit', (code) => {
        if (!this.closing || code !== 0) fail(new Error('存储线程已停止，请重启服务后重试'));
        resolve();
      }),
    );
  }

  static async open(directory: string, options: { migrateLegacy?: boolean } = {}) {
    let entry = new URL('./state-worker.js', import.meta.url);
    if (import.meta.url.endsWith('.ts')) {
      // Development only; packaged applications use compiled JavaScript without a TS loader.
      const loader = import.meta.resolve('tsx/esm/api');
      const source = new URL('./state-worker.ts', import.meta.url).href;
      entry = new URL(
        'data:text/javascript,' +
          encodeURIComponent(
            `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`,
          ),
      );
    }
    const repository = new WorkerStateRepository(
      new Worker(entry, {
        workerData: { directory, migrateLegacy: !!options.migrateLegacy },
        execArgv: [],
      }),
    );
    try {
      await repository.ready;
      return repository;
    } catch (error) {
      await repository.worker.terminate();
      await repository.exited;
      throw error;
    }
  }

  private request(
    operation:
      | 'library'
      | 'load'
      | 'save'
      | 'close'
      | 'readDraft'
      | 'writeDraft'
      | 'listDraftRecoveries'
      | 'archiveDraft',
    state?: State,
    key?: string,
    input?: DraftWrite,
    copy?: DraftCopy,
    library?: LibraryQuery,
  ): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing && operation !== 'close') return Promise.reject(new Error('存储已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, operation, state, key, input, copy, library });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  library(query: LibraryQuery) {
    return this.request('library', undefined, undefined, undefined, undefined, query);
  }
  load() {
    return this.request('load');
  }
  async save(state: State) {
    await this.request('save', state);
  }
  async archiveDraft(key: string, input: DraftCopy) {
    await this.request('archiveDraft', undefined, key, undefined, input);
  }
  async listDraftRecoveries(key: string) {
    return (await this.request('listDraftRecoveries', undefined, key)) as DraftRecovery[];
  }
  async readDraft(key: string) {
    return (await this.request('readDraft', undefined, key)) as DraftSnapshot;
  }
  async writeDraft(key: string, input: DraftWrite) {
    return (await this.request('writeDraft', undefined, key, input)) as DraftResult;
  }
  close(): Promise<void> {
    if (!this.closing)
      this.closing = (async () => {
        try {
          if (this.failure) await this.worker.terminate();
          else await this.request('close');
        } catch (error) {
          await this.worker.terminate();
          throw error;
        } finally {
          await this.exited;
        }
      })();
    return this.closing;
  }
}
