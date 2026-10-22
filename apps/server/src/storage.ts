import { type State } from '../../../packages/shared/types.js';
import { JsonSnapshotRepository } from '../../../packages/storage/json-snapshot-repository.js';
import type { SnapshotRepository } from '../../../packages/storage/snapshot-repository.js';
import { decodeState, initialState } from './state-schema.js';
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
  state: State;
  private readonly repository: SnapshotRepository<State>;
  constructor(source: string | SnapshotRepository<State>) {
    this.repository = typeof source === 'string' ? new JsonSnapshotRepository(source) : source;
    // Parse before writing: corrupt or future-version data must remain untouched.
    const persisted = this.repository.load();
    this.state = persisted === undefined ? initialState() : decodeState(persisted);
    for (const c of this.state.conversations)
      for (const m of c.messages)
        if (m.status === 'streaming') {
          m.status = 'failed';
          c.activities.push({
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            label: '服务重启，上一次生成已中断',
          });
        }
    this.save();
  }
  replace(next: State) {
    const validated = decodeState(next);
    this.repository.save(validated);
    this.state = validated;
  }
  save() {
    this.repository.save(this.state);
  }
}
