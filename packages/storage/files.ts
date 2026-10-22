import { closeSync, fsyncSync, openSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

export function syncFile(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function syncDirectory(path: string) {
  // Windows does not expose directory fsync through this API; platform durability needs separate QA.
  if (process.platform !== 'win32') syncFile(path);
}
export function atomicWrite(path: string, data: string | Buffer, mode = 0o600) {
  const temporary = path + '.tmp';
  requireRegularFile(temporary);
  writeFileSync(temporary, data, { mode });
  syncFile(temporary);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}
export function requireRegularFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw new Error('数据目录包含非普通文件，请先检查并修复');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
