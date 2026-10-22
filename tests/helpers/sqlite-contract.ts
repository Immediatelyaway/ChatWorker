import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteDatabase, type SqliteOptions } from '../../packages/storage/sqlite.js';

/** The same behavioral checks run in Node, Electron main and a packaged Electron app. */
export function verifySqliteContract(
  directory: string,
  journalMode: SqliteOptions['journalMode'] = 'delete',
) {
  const file = join(directory, `${journalMode}.sqlite`);
  const options = { busyTimeoutMs: 20, journalMode };
  const db = openSqliteDatabase(file, options);
  const content = "中文 🐈 '); DROP TABLE projects; --\n第二行";
  const bytes = new Uint8Array([0, 1, 127, 255]);
  let sqliteVersion: string;
  try {
    sqliteVersion = String(db.prepare('SELECT sqlite_version() AS version').get()?.version);
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        content TEXT NOT NULL,
        attachment BLOB NOT NULL
      ) STRICT;
    `);
    const insertProject = db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)');
    const insertMessage = db.prepare(
      'INSERT INTO messages (id, project_id, content, attachment) VALUES (?, ?, ?, ?)',
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      insertProject.run('p1', '验证项目');
      insertMessage.run('m1', 'p1', content, bytes);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    // A later constraint failure must roll back all preceding writes in the transaction.
    db.exec('BEGIN IMMEDIATE');
    try {
      insertProject.run('p2', '应回滚');
      insertMessage.run('m2', 'p2', '应回滚', bytes);
      assert.throws(() => insertMessage.run('m3', 'missing', '孤立消息', bytes), /FOREIGN KEY/);
    } finally {
      db.exec('ROLLBACK');
    }
    assert.equal(db.prepare('SELECT count(*) AS count FROM projects').get()?.count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM messages').get()?.count, 1);
    assert.throws(() => insertProject.run('p1', '重复 ID'), /UNIQUE/);

    const other = openSqliteDatabase(file, options);
    try {
      db.exec('BEGIN IMMEDIATE');
      insertProject.run('uncommitted', '不可见');
      // A reserved write transaction allows readers to see committed state in both modes.
      assert.equal(other.prepare('SELECT count(*) AS count FROM projects').get()?.count, 1);
      assert.throws(
        () => other.exec('BEGIN IMMEDIATE'),
        (error: unknown) => error instanceof Error && 'errcode' in error && error.errcode === 5,
      );
      if (process.platform !== 'win32') {
        const suffixes = journalMode === 'wal' ? ['', '-wal', '-shm'] : ['', '-journal'];
        for (const suffix of suffixes) assert.equal(statSync(file + suffix).mode & 0o777, 0o600);
      }
      db.exec('ROLLBACK');
      // The failed second writer can proceed once the first writer releases its lock.
      other.exec('BEGIN IMMEDIATE');
      other.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('p3', '锁已释放');
      other.exec('COMMIT');
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK');
      if (other.isTransaction) other.exec('ROLLBACK');
      other.close();
    }
  } finally {
    db.close();
  }

  const reopened = openSqliteDatabase(file, { journalMode });
  try {
    assert.equal(reopened.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM projects').get()?.count, 2);
    const message = reopened.prepare('SELECT * FROM messages WHERE id = ?').get('m1');
    assert.equal(message?.content, content);
    assert.deepEqual(message?.attachment, bytes);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM messages').get()?.count, 1);
  } finally {
    reopened.close();
  }
  return {
    sqlite: sqliteVersion,
    journalMode,
    checks: [
      'persistence',
      'bound-parameters',
      'blob',
      'rollback',
      'foreign-keys',
      'unique-id',
      'committed-reader',
      'busy-writer',
      'lock-release',
      'reopen',
      'quick-check',
    ],
  };
}
