import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { LIBRARY_LIMITS, type LibraryDocument, type LibraryQuery } from '../contracts/library.js';
import { chunks, retrieve, type IndexedChunk } from '../knowledge/retrieval.js';
export function createLibraryTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE library_documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, original BLOB NOT NULL, source_json TEXT, favorite INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
  CREATE INDEX library_hash ON library_documents(hash);
  CREATE TABLE library_chunks (document_id TEXT NOT NULL REFERENCES library_documents(id) ON DELETE CASCADE, position INTEGER NOT NULL, text TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, terms_json TEXT NOT NULL, token_count INTEGER NOT NULL, PRIMARY KEY(document_id,position)) STRICT;`);
}
function document(db: DatabaseSync, id: string): LibraryDocument | undefined {
  const row = db
    .prepare(
      'SELECT id,title,format,text,hash,source_json,favorite,enabled,deleted,created_at,updated_at FROM library_documents WHERE id=?',
    )
    .get(id);
  if (!row) return;
  return {
    id: String(row.id),
    title: String(row.title),
    format: String(row.format),
    text: String(row.text),
    hash: String(row.hash),
    characters: String(row.text).length,
    chunks: Number(
      db.prepare('SELECT count(*) AS n FROM library_chunks WHERE document_id=?').get(id)!.n,
    ),
    favorite: !!row.favorite,
    enabled: !!row.enabled,
    deleted: !!row.deleted,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.source_json ? { source: JSON.parse(String(row.source_json)) } : {}),
  };
}
export function executeLibrary(db: DatabaseSync, query: LibraryQuery): unknown {
  if (query.action === 'list')
    return db
      .prepare('SELECT id FROM library_documents ORDER BY updated_at DESC,id')
      .all()
      .map((row) => {
        const { text, ...meta } = document(db, String(row.id))!;
        return meta;
      });
  if (query.action === 'get') return document(db, query.id) ?? null;
  if (query.action === 'download')
    return (
      db.prepare('SELECT title,format,original FROM library_documents WHERE id=?').get(query.id) ??
      null
    );
  if (query.action === 'search') {
    const allowed = query.documentIds && new Set(query.documentIds);
    const rows = db
      .prepare(
        'SELECT c.*,d.title,d.hash FROM library_chunks c JOIN library_documents d ON d.id=c.document_id WHERE d.enabled=1 AND d.deleted=0',
      )
      .all();
    const records: IndexedChunk[] = rows
      .filter((r) => !allowed || allowed.has(String(r.document_id)))
      .map((r) => ({
        documentId: String(r.document_id),
        title: String(r.title),
        hash: String(r.hash),
        chunkIndex: Number(r.position),
        startLine: Number(r.start_line),
        endLine: Number(r.end_line),
        text: String(r.text),
        terms: JSON.parse(String(r.terms_json)),
        length: Number(r.token_count),
      }));
    return retrieve(query.query, records);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    let id: string;
    if (query.action === 'create') {
      const original = query.original ?? Buffer.from(query.text),
        hash = createHash('sha256').update(original).digest('hex');
      const duplicate = db
        .prepare('SELECT id FROM library_documents WHERE hash=? AND deleted=0')
        .get(hash);
      if (duplicate) {
        db.exec('COMMIT');
        return document(db, String(duplicate.id));
      }
      const usage = db
        .prepare(
          'SELECT count(*) AS n,coalesce(sum(length(original)),0) AS bytes,coalesce(sum(length(text)),0) AS characters FROM library_documents',
        )
        .get()!;
      if (
        Number(usage.n) >= LIBRARY_LIMITS.documents ||
        Number(usage.bytes) + original.length > LIBRARY_LIMITS.totalBytes ||
        Number(usage.characters) + query.text.length > 10_000_000
      )
        throw Object.assign(new Error('空间容量已达上限，请先保管资料并整理资料库'), {
          code: 'LIBRARY_LIMIT',
        });
      id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO library_documents (id,title,format,text,hash,original,source_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        query.title,
        query.format,
        query.text,
        hash,
        original,
        query.source ? JSON.stringify(query.source) : null,
        now,
        now,
      );
      const insert = db.prepare('INSERT INTO library_chunks VALUES (?,?,?,?,?,?,?)');
      chunks(query.text).forEach((c, i) =>
        insert.run(id, i, c.text, c.startLine, c.endLine, JSON.stringify(c.terms), c.length),
      );
    } else {
      id = query.id;
      const before = document(db, id);
      if (!before) {
        db.exec('COMMIT');
        return null;
      }
      const next = { ...before, ...query.patch };
      db.prepare(
        'UPDATE library_documents SET title=?,favorite=?,enabled=?,deleted=?,updated_at=? WHERE id=?',
      ).run(
        next.title,
        Number(next.favorite),
        Number(next.enabled),
        Number(next.deleted),
        new Date().toISOString(),
        id,
      );
    }
    db.exec('COMMIT');
    return document(db, id);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
