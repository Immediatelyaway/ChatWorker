import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { requireRegularFile } from './files.js';

export class StorageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Hold an OS-backed SQLite exclusive lock for the service lifetime. Never unlink the file. */
export function lockDirectory(directory: string): () => void {
  const file = join(directory, 'writer.lock.sqlite');
  requireRegularFile(file);
  closeSync(openSync(file, 'a', 0o600));
  const lock = new DatabaseSync(file, { timeout: 0 });
  try {
    lock.exec(
      'PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); COMMIT; BEGIN EXCLUSIVE;',
    );
  } catch (error) {
    lock.close();
    throw new StorageError(
      'STORE_BUSY',
      '此资料目录已被其他服务使用，或目录锁不可用，请先关闭相关服务',
    );
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    lock.close();
  };
}
