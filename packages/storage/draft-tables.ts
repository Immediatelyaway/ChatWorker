import { randomUUID, createHash } from 'node:crypto';
import type { Draft, DraftRecovery, DraftCopy } from '../contracts/drafts.js';
import { draftRecoverySchema, draftCopySchema } from '../contracts/drafts.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  draftKeySchema,
  draftWriteSchema,
  draftSnapshotSchema,
  blankDraft,
  type DraftWrite,
  type DraftResult,
} from '../contracts/drafts.js';
import { StorageError } from './directory-lock.js';

export function createDraftTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE drafts (
    owner_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision > 0 AND revision < 9007199254740991),
    text TEXT NOT NULL,
    attachments_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE draft_recoveries (
    id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, revision INTEGER NOT NULL,
    text TEXT NOT NULL, attachments_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(owner_key,content_hash)
  ) STRICT;`);
}
export function validateDraftTarget(db: DatabaseSync, key: string) {
  draftKeySchema.parse(key);
  const conversation = key.startsWith('conversation:') ? key.slice(13) : null;
  const project = conversation === null ? key.replace(/^new:(chat|work):/, '') : '';
  if (
    (conversation !== null &&
      !db.prepare('SELECT id FROM conversations WHERE id=?').get(conversation)) ||
    (project && !db.prepare('SELECT id FROM projects WHERE id=?').get(project))
  )
    throw new StorageError('DRAFT_TARGET_MISSING', '草稿所属会话或项目已删除，请先保留本窗口内容');
}
export function readDraftRow(db: DatabaseSync, key: string) {
  validateDraftTarget(db, key);
  const row = db.prepare('SELECT * FROM drafts WHERE owner_key=?').get(key);
  return draftSnapshotSchema.parse(
    row
      ? {
          key,
          revision: row.revision,
          updatedAt: row.updated_at,
          draft: { text: row.text, attachments: JSON.parse(String(row.attachments_json)) },
        }
      : { key, revision: 0, updatedAt: null, draft: blankDraft() },
  );
}
export function writeDraftRow(db: DatabaseSync, key: string, value: DraftWrite): DraftResult {
  const input = draftWriteSchema.parse(value);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readDraftRow(db, key);
    if (current.revision !== input.expectedRevision) {
      preserveDraft(db, key, input.draft, input.expectedRevision);
      db.exec('COMMIT');
      return { ok: false, current };
    }
    if (input.preservePrevious) preserveDraft(db, key, current.draft, current.revision);
    const next = draftSnapshotSchema.parse({
      key,
      revision: current.revision + 1,
      draft: input.draft,
      updatedAt: new Date().toISOString(),
    });
    db.prepare(
      `INSERT INTO drafts VALUES (?,?,?,?,?) ON CONFLICT(owner_key) DO UPDATE SET revision=excluded.revision, text=excluded.text, attachments_json=excluded.attachments_json, updated_at=excluded.updated_at`,
    ).run(
      key,
      next.revision,
      next.draft.text,
      JSON.stringify(next.draft.attachments),
      next.updatedAt,
    );
    db.exec('COMMIT');
    return { ok: true, current: next };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function preserveDraft(db: DatabaseSync, key: string, draft: Draft, revision: number) {
  if (!draft.text && !draft.attachments.length) return;
  const hash = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
  db.prepare('INSERT OR IGNORE INTO draft_recoveries VALUES (?,?,?,?,?,?,?)').run(
    randomUUID(),
    key,
    revision,
    draft.text,
    JSON.stringify(draft.attachments),
    hash,
    new Date().toISOString(),
  );
}
export function listDraftRecoveries(db: DatabaseSync, key: string): DraftRecovery[] {
  validateDraftTarget(db, key);
  return db
    .prepare('SELECT * FROM draft_recoveries WHERE owner_key=? ORDER BY created_at DESC')
    .all(key)
    .map((row) =>
      draftRecoverySchema.parse({
        id: row.id,
        revision: row.revision,
        draft: { text: row.text, attachments: JSON.parse(String(row.attachments_json)) },
        createdAt: row.created_at,
      }),
    );
}

export function archiveDraft(db: DatabaseSync, key: string, value: DraftCopy) {
  const input = draftCopySchema.parse(value);
  db.exec('BEGIN IMMEDIATE');
  try {
    validateDraftTarget(db, key);
    preserveDraft(db, key, input.draft, input.revision);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
