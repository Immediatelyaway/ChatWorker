import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
  chmodSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { decodeState, initialState } from '../contracts/state.js';
import type { State } from '../shared/types.js';
import { openSqliteDatabase } from './sqlite.js';
import {
  APPLICATION_ID,
  DATABASE_VERSION,
  createStateTables,
  readStateRows,
  writeStateRows,
} from './state-tables.js';
import { atomicWrite, requireRegularFile, syncDirectory, syncFile } from './files.js';
import {
  createDraftTables,
  readDraftRow,
  writeDraftRow,
  listDraftRecoveries,
  archiveDraft,
} from './draft-tables.js';
import type { DraftWrite, DraftCopy } from '../contracts/drafts.js';
import { lockDirectory, StorageError } from './directory-lock.js';

const manifestSchema = z
  .object({
    version: z.literal(1),
    storeId: z.string().uuid(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
const markerSchema = z
  .object({ version: z.literal(1), backend: z.literal('sqlite'), storeId: z.string().uuid() })
  .strict();
export type MigrationPhase =
  | 'planned'
  | 'backup-created'
  | 'importing'
  | 'import-committed'
  | 'before-switch'
  | 'after-switch'
  | 'ready';
export interface DatabaseOptions {
  migrateLegacy?: boolean;
  /** In-process fault injection for migration tests, never exposed by HTTP or environment. */
  onMigrationPhase?: (phase: MigrationPhase) => void;
}
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');

function checkHeader(file: string) {
  const header = Buffer.alloc(100);
  const fd = openSync(file, 'r');
  try {
    if (
      readSync(fd, header, 0, 100, 0) !== 100 ||
      header.subarray(0, 16).toString() !== 'SQLite format 3\0'
    )
      throw new StorageError('INVALID_DATABASE', '数据库文件损坏，已保留原文件，请从备份恢复');
  } finally {
    closeSync(fd);
  }
  if (
    ![1, DATABASE_VERSION].includes(header.readUInt32BE(60)) ||
    header.readUInt32BE(68) !== APPLICATION_ID
  )
    throw new StorageError('DATABASE_VERSION', '数据库版本不受支持，已保留原文件，请使用兼容版本');
  if (header[18] !== 1 || header[19] !== 1)
    throw new StorageError('DATABASE_MODE', '此数据库的日志格式不受当前业务存储支持，已保留原文件');
}

function openExisting(file: string, expectedIds: (string | undefined)[] = []) {
  // Read the header before writable open. A known-schema hot journal may then be recovered by SQLite.
  checkHeader(file);
  for (const suffix of ['-journal', '-wal', '-shm']) requireRegularFile(file + suffix);
  const db = new DatabaseSync(file, {
    timeout: 1_000,
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });
  try {
    if (
      ![1, DATABASE_VERSION].includes(
        Number(db.prepare('PRAGMA user_version').get()?.user_version),
      ) ||
      db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
      db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete'
    )
      throw new StorageError('DATABASE_VERSION', '数据库版本或日志模式不受支持');
    if (
      db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new StorageError('INVALID_DATABASE', '数据库完整性校验失败，已保留原文件');
    readStateRows(db);
    const storeId = z
      .string()
      .uuid()
      .parse(db.prepare("SELECT value FROM metadata WHERE key='storeId'").get()?.value);
    if (expectedIds.some((id) => id && id !== storeId))
      throw new StorageError('STORE_ID_MISMATCH', '数据库与资料目录标识不一致，请先检查备份');
    db.exec('PRAGMA synchronous=FULL');
    if (db.prepare('PRAGMA user_version').get()?.user_version === 1) {
      // The directory lock is held and hot journals have recovered. Hold a DB write lock too.
      db.exec('BEGIN IMMEDIATE');
      try {
        const bytes = readFileSync(file);
        const backup = file + '.backup-v1-' + hash(bytes);
        if (requireRegularFile(backup)) {
          if (hash(readFileSync(backup)) !== hash(bytes))
            throw new StorageError('BACKUP_CORRUPT', '数据库升级备份校验失败');
        } else atomicWrite(backup, bytes);
        chmodSync(backup, 0o400);
        syncFile(backup);
        createDraftTables(db);
        db.exec('PRAGMA user_version = ' + DATABASE_VERSION);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    }
    db.prepare(
      'SELECT owner_key,revision,text,attachments_json,updated_at FROM drafts LIMIT 0',
    ).all();
    db.prepare(
      'SELECT id,owner_key,revision,text,attachments_json,content_hash,created_at FROM draft_recoveries LIMIT 0',
    ).all();
    return { db, storeId };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Runs only in the storage worker (or an isolated test process). */
export class StateDatabase {
  private constructor(
    private readonly db: DatabaseSync,
    readonly storeId: string,
    private readonly unlock: () => void,
  ) {}
  private closed = false;

  static open(directory: string, options: DatabaseOptions = {}): StateDatabase {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = realpathSync(resolve(directory));
    const unlock = lockDirectory(dir);
    let opened: ReturnType<typeof openExisting> | undefined;
    try {
      const database = join(dir, 'state.sqlite');
      const legacy = join(dir, 'state.json');
      const markerFile = join(dir, 'storage.json');
      const planFile = join(dir, 'migration.json');
      const staging = join(dir, 'state.sqlite.migrating');
      const marker = requireRegularFile(markerFile)
        ? markerSchema.parse(JSON.parse(readFileSync(markerFile, 'utf8')))
        : undefined;
      const plan = requireRegularFile(planFile)
        ? manifestSchema.parse(JSON.parse(readFileSync(planFile, 'utf8')))
        : undefined;
      if (marker && !requireRegularFile(database))
        throw new StorageError(
          'DATABASE_MISSING',
          '数据库文件缺失，不能回退到旧 JSON，请恢复数据库备份',
        );
      if (!requireRegularFile(database)) {
        let migration = plan;
        let bytes: Buffer | undefined;
        let state: State;
        if (!migration) {
          if (requireRegularFile(staging))
            throw new StorageError('MIGRATION_CONFLICT', '发现没有迁移记录的临时数据库，请先检查');
          bytes = requireRegularFile(legacy) ? readFileSync(legacy) : undefined;
          state = bytes
            ? decodeState(JSON.parse(bytes.toString('utf8')))
            : decodeState(initialState());
          if (bytes && !options.migrateLegacy)
            throw new StorageError(
              'LEGACY_MIGRATION_REQUIRED',
              '检测到旧版数据。请先关闭使用此目录的旧版桌面和 Web 服务，再执行离线迁移。',
            );
          migration = { version: 1, storeId: randomUUID(), sourceHash: bytes ? hash(bytes) : null };
          atomicWrite(planFile, JSON.stringify(migration));
          options.onMigrationPhase?.('planned');
        }
        if (migration.sourceHash) {
          const backup = join(dir, `state.json.backup-${migration.sourceHash}`);
          if (requireRegularFile(backup)) {
            bytes = readFileSync(backup);
            if (hash(bytes) !== migration.sourceHash)
              throw new StorageError('BACKUP_CORRUPT', '迁移备份校验失败，已保留所有原文件');
          } else {
            bytes = readFileSync(legacy);
            if (hash(bytes) !== migration.sourceHash)
              throw new StorageError('SOURCE_CHANGED', '旧数据在迁移期间发生变化，请先检查');
            decodeState(JSON.parse(bytes.toString('utf8')));
            atomicWrite(backup, bytes);
            chmodSync(backup, 0o400);
            syncFile(backup);
          }
          state = decodeState(JSON.parse(bytes.toString('utf8')));
        } else {
          if (requireRegularFile(legacy))
            throw new StorageError('SOURCE_CHANGED', '初始化期间出现旧数据文件，请先检查');
          state = decodeState(initialState());
        }
        options.onMigrationPhase?.('backup-created');
        // Only a recorded, never-activated staging DB may be rebuilt after an interrupted import.
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          if (requireRegularFile(staging + suffix)) rmSync(staging + suffix);
        }
        const temp = openSqliteDatabase(staging);
        try {
          temp.exec('BEGIN IMMEDIATE');
          createStateTables(temp, migration.storeId);
          writeStateRows(temp, state);
          options.onMigrationPhase?.('importing');
          temp.exec('COMMIT');
          options.onMigrationPhase?.('import-committed');
          assert.deepEqual(readStateRows(temp), state);
          assert.equal(temp.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
          assert.equal(temp.prepare('PRAGMA foreign_key_check').all().length, 0);
        } finally {
          temp.close();
        }
        syncFile(staging);
        if (migration.sourceHash && hash(readFileSync(legacy)) !== migration.sourceHash)
          throw new StorageError('SOURCE_CHANGED', '旧数据在迁移期间发生变化，未切换数据库');
        options.onMigrationPhase?.('before-switch');
        renameSync(staging, database);
        syncDirectory(dir);
        options.onMigrationPhase?.('after-switch');
      }
      opened = openExisting(database, [marker?.storeId, plan?.storeId]);
      if (
        (marker && marker.storeId !== opened.storeId) ||
        (plan && plan.storeId !== opened.storeId)
      )
        throw new StorageError('STORE_ID_MISMATCH', '数据库与资料目录标识不一致，请先检查备份');
      if (!marker)
        atomicWrite(
          markerFile,
          JSON.stringify({ version: 1, backend: 'sqlite', storeId: opened.storeId }),
        );
      options.onMigrationPhase?.('ready');
      return new StateDatabase(opened.db, opened.storeId, unlock);
    } catch (error) {
      opened?.db.close();
      unlock();
      throw error;
    }
  }

  load(): State {
    this.assertOpen();
    return readStateRows(this.db);
  }
  save(state: State) {
    this.assertOpen();
    const validated = decodeState(state);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      writeStateRows(this.db, validated);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  archiveDraft(key: string, input: DraftCopy) {
    this.assertOpen();
    archiveDraft(this.db, key, input);
  }
  listDraftRecoveries(key: string) {
    this.assertOpen();
    return listDraftRecoveries(this.db, key);
  }
  readDraft(key: string) {
    this.assertOpen();
    return readDraftRow(this.db, key);
  }
  writeDraft(key: string, input: DraftWrite) {
    this.assertOpen();
    return writeDraftRow(this.db, key, input);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.unlock();
    }
  }
  private assertOpen() {
    if (this.closed) throw new Error('存储已关闭');
  }
}
