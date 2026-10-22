import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openSqliteDatabase,
  hasWalResetFix,
  sqliteRuntimeVersion,
} from '../packages/storage/sqlite.js';
import { verifySqliteContract } from './helpers/sqlite-contract.js';

test('SQLite persists bound values and enforces rollback, foreign keys and writer locking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-sqlite-test-'));
  try {
    verifySqliteContract(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite rejects invalid configuration before creating a file and does not overwrite corrupt bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-sqlite-errors-'));
  const file = join(dir, 'state.sqlite');
  try {
    assert.throws(() => openSqliteDatabase('relative.sqlite'), /absolute/);
    for (const timeout of [-1, 0.5, NaN, Infinity, 30_001])
      assert.throws(() => openSqliteDatabase(file, { busyTimeoutMs: timeout }), /timeout/);
    assert.equal(existsSync(file), false);
    const corrupt = Buffer.from('This is not a SQLite database.\n'.repeat(30));
    writeFileSync(file, corrupt);
    assert.throws(() => openSqliteDatabase(file), /not a database/);
    assert.deepEqual(readFileSync(file), corrupt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WAL requires a known fixed runtime and blocked requests create no database', () => {
  for (const version of ['3.44.5', '3.45.6', '3.50.4', '3.50.6', '3.51.2', 'unknown', '4.0.0'])
    assert.equal(hasWalResetFix(version), false, version);
  for (const version of ['3.44.6', '3.50.7', '3.51.3', '3.52.0', '3.53.4'])
    assert.equal(hasWalResetFix(version), true, version);
  const dir = mkdtempSync(join(tmpdir(), 'chatworker-wal-gate-'));
  try {
    if (hasWalResetFix(sqliteRuntimeVersion())) {
      verifySqliteContract(dir, 'wal');
    } else {
      const file = join(dir, 'wal.sqlite');
      assert.throws(() => openSqliteDatabase(file, { journalMode: 'wal' }), /WAL-reset fix/);
      assert.equal(existsSync(file), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
