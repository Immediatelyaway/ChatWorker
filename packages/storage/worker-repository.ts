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

  private request(operation: 'load' | 'save' | 'close', state?: State): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing && operation !== 'close') return Promise.reject(new Error('存储已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, operation, state });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  load() {
    return this.request('load');
  }
  async save(state: State) {
    await this.request('save', state);
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
