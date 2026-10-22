import { closeSync, openSync, chmodSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SqliteOptions {
  busyTimeoutMs?: number;
  journalMode?: 'delete' | 'wal';
}

export function sqliteRuntimeVersion(): string {
  const probe = new DatabaseSync(':memory:');
  try {
    return String(probe.prepare('SELECT sqlite_version() AS version').get()?.version);
  } finally {
    probe.close();
  }
}

/** Known WAL-reset fixes: https://sqlite.org/wal.html#walresetbug */
export function hasWalResetFix(version: string): boolean {
  if (!/^3\.\d+\.\d+$/.test(version)) return false;
  const [, minor, patch] = version.split('.').map(Number);
  return (
    minor > 51 ||
    (minor === 51 && patch >= 3) ||
    (minor === 50 && patch >= 7) ||
    (minor === 44 && patch >= 6)
  );
}

/**
 * CW-002 driver candidate. Not imported by the running JSON-backed application.
 * Caller owns the private local directory, schema/version checks, transactions and close().
 * All operations (including busy waits) block the calling thread.
 */
export function openSqliteDatabase(filename: string, options: SqliteOptions = {}): DatabaseSync {
  const { busyTimeoutMs = 1_000, journalMode = 'delete' } = options;
  if (!isAbsolute(filename)) throw new Error('SQLite requires an absolute local file path');
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 30_000)
    throw new Error('SQLite busy timeout must be an integer between 0 and 30000 ms');
  if (journalMode !== 'delete' && journalMode !== 'wal')
    throw new Error('Unsupported journal mode');
  if (journalMode === 'wal' && !hasWalResetFix(sqliteRuntimeVersion()))
    throw new Error(
      'WAL requires SQLite with the WAL-reset fix; upgrade the runtime or use DELETE',
    );

  // Create privately before SQLite creates WAL/SHM files. Existing files are not truncated.
  closeSync(openSync(filename, 'a', 0o600));
  chmodSync(filename, 0o600);
  const db = new DatabaseSync(filename, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: busyTimeoutMs,
  });
  try {
    const journal = db
      .prepare(journalMode === 'wal' ? 'PRAGMA journal_mode = WAL' : 'PRAGMA journal_mode = DELETE')
      .get();
    db.exec('PRAGMA synchronous = FULL');
    if (
      journal?.journal_mode !== journalMode ||
      db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
      db.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
      db.prepare('PRAGMA busy_timeout').get()?.timeout !== busyTimeoutMs
    ) {
      throw new Error('SQLite did not apply the required connection settings');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
