import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { providerDefaults, type State } from '../../../packages/shared/types.js';
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
    this.state = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : {
          conversations: [],
          projects: [],
          providers: providerDefaults,
          preferences: {
            theme: 'light',
            providerId: 'demo',
            model: '本地演示',
            systemPrompt:
              '你是 ChatWorker，一位清晰、可靠的助手。优先使用用户的语言，明确区分事实、建议和未完成的操作。',
          },
        };
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
  save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
