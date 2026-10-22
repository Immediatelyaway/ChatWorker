import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotRepository } from './snapshot-repository.js';

/** File IO only. Validation and restart recovery belong to the application layer. */
export class JsonSnapshotRepository<T> implements SnapshotRepository<T> {
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'state.json');
  }

  load(): unknown | undefined {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : undefined;
  }

  save(value: T): void {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
