import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { type State } from '../../../packages/shared/types.js';
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
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'state.json');
    // Parse before writing: corrupt or future-version data must remain untouched.
    this.state = existsSync(this.file)
      ? decodeState(JSON.parse(readFileSync(this.file, 'utf8')))
      : initialState();
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
    this.write(validated);
    this.state = validated;
  }
  save() {
    this.write(this.state);
  }
  private write(state: State) {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
