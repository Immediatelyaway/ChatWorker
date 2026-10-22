import { type State } from '../../../packages/shared/types.js';
import { WorkerStateRepository } from '../../../packages/storage/worker-repository.js';
import type { StateRepository } from '../../../packages/storage/state-repository.js';
import { decodeState } from './state-schema.js';
export interface SecretStore {
  get(id: string): string;
  set(id: string, value: string): void;
  persistent: boolean;
}
export function memorySecrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: (id) => data.get(id) ?? '',
    set: (id, value) => {
      value ? data.set(id, value) : data.delete(id);
    },
    persistent: false,
  };
}
export class Storage {
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private constructor(
    private readonly repository: StateRepository,
    private current: State,
  ) {}
  get state() {
    return this.current;
  }
  get storeId() {
    return this.repository.storeId;
  }
  static async open(directory: string, options: { migrateLegacy?: boolean } = {}) {
    return Storage.create(await WorkerStateRepository.open(directory, options));
  }
  static async create(repository: StateRepository) {
    try {
      const state = decodeState(await repository.load());
      let recovered = false;
      for (const c of state.conversations)
        for (const m of c.messages)
          if (m.status === 'streaming') {
            recovered = true;
            m.status = 'failed';
            c.activities.push({
              id: crypto.randomUUID(),
              at: new Date().toISOString(),
              label: '服务重启，上一次生成已中断',
            });
          }
      if (recovered) await repository.save(state);
      return new Storage(repository, state);
    } catch (error) {
      await repository.close();
      throw error;
    }
  }
  /** Mutators must be synchronous. Only committed snapshots become visible to other requests. */
  update<T>(mutate: (next: State) => T): Promise<T> {
    if (this.closing) return Promise.reject(new Error('存储已关闭'));
    const task = this.tail.then(async () => {
      const next = structuredClone(this.current);
      const result = mutate(next);
      if (result instanceof Promise) throw new Error('存储变更不能包含异步操作');
      const response = structuredClone(result);
      const validated = decodeState(next);
      await this.repository.save(validated);
      this.current = validated;
      return response;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  replace(next: State) {
    const replacement = decodeState(next);
    return this.update((state) => {
      Object.assign(state, replacement);
    });
  }
  close(): Promise<void> {
    this.closing ??= this.tail.then(() => this.repository.close());
    return this.closing;
  }
}
