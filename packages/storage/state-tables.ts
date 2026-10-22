import { createDraftTables } from './draft-tables.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { decodeState } from '../contracts/state.js';
import { STATE_VERSION, DATABASE_VERSION } from '../contracts/versions.js';
import type { State } from '../shared/types.js';

export { DATABASE_VERSION } from '../contracts/versions.js';
export const APPLICATION_ID = 0x43574b52;

export function createStateTables(db: DatabaseSync, storeId: string = randomUUID()) {
  db.exec(`
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = ${DATABASE_VERSION};
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE projects (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL) STRICT;
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, project_id TEXT REFERENCES projects(id),
      title TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1))
    ) STRICT;
    CREATE TABLE messages (
      conversation_id TEXT NOT NULL REFERENCES conversations(id), id TEXT NOT NULL, position INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT, model TEXT,
      has_attachments INTEGER NOT NULL CHECK(has_attachments IN (0,1)),
      PRIMARY KEY(conversation_id,id), UNIQUE(conversation_id,position)
    ) STRICT;
    CREATE TABLE attachments (
      conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, position INTEGER NOT NULL,
      name TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(conversation_id,message_id,position),
      FOREIGN KEY(conversation_id,message_id) REFERENCES messages(conversation_id,id)
    ) STRICT;
    CREATE TABLE activities (
      conversation_id TEXT NOT NULL REFERENCES conversations(id), position INTEGER NOT NULL,
      id TEXT NOT NULL, label TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(conversation_id,position)
    ) STRICT;
    CREATE TABLE providers (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, name TEXT NOT NULL, protocol TEXT NOT NULL, base_url TEXT NOT NULL) STRICT;
    CREATE TABLE provider_models (provider_id TEXT NOT NULL REFERENCES providers(id), position INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY(provider_id,position)) STRICT;
    CREATE TABLE preferences (singleton INTEGER PRIMARY KEY CHECK(singleton=1), theme TEXT NOT NULL, provider_id TEXT NOT NULL REFERENCES providers(id), model TEXT NOT NULL, system_prompt TEXT NOT NULL) STRICT;
  `);
  createDraftTables(db);
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('storeId', storeId);
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('stateVersion', String(STATE_VERSION));
}

/** Caller owns the transaction. Full-state persistence is transitional; records are relational. */
export function writeStateRows(db: DatabaseSync, input: State) {
  const state = decodeState(input);
  db.exec(
    'DELETE FROM attachments; DELETE FROM activities; DELETE FROM messages; DELETE FROM conversations; DELETE FROM projects; DELETE FROM preferences; DELETE FROM provider_models; DELETE FROM providers;',
  );
  const project = db.prepare('INSERT INTO projects VALUES (?,?,?,?)');
  const conversation = db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?)');
  const message = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)');
  const attachment = db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?)');
  const activity = db.prepare('INSERT INTO activities VALUES (?,?,?,?,?)');
  const provider = db.prepare('INSERT INTO providers VALUES (?,?,?,?,?)');
  const model = db.prepare('INSERT INTO provider_models VALUES (?,?,?)');
  state.projects.forEach((p, i) => project.run(p.id, i, p.name, p.description));
  state.conversations.forEach((c, i) => {
    conversation.run(
      c.id,
      i,
      c.projectId,
      c.title,
      c.mode,
      c.createdAt,
      c.updatedAt,
      Number(c.archived),
    );
    c.messages.forEach((m, j) => {
      message.run(
        c.id,
        m.id,
        j,
        m.role,
        m.content,
        m.createdAt,
        m.status ?? null,
        m.model ?? null,
        Number(m.attachments !== undefined),
      );
      m.attachments?.forEach((a, k) => attachment.run(c.id, m.id, k, a.name, a.content));
    });
    c.activities.forEach((a, j) => activity.run(c.id, j, a.id, a.label, a.at));
  });
  state.providers.forEach((p, i) => {
    provider.run(p.id, i, p.name, p.protocol, p.baseUrl);
    p.models.forEach((name, j) => model.run(p.id, j, name));
  });
  // Keep revision tombstones so stale clients cannot recreate deleted context drafts.
  const projectIds = new Set(state.projects.map((p) => p.id));
  const conversationIds = new Set(state.conversations.map((c) => c.id));
  for (const row of db
    .prepare("SELECT owner_key FROM drafts WHERE text <> '' OR attachments_json <> '[]'")
    .all()) {
    const key = String(row.owner_key);
    const missing = key.startsWith('conversation:')
      ? !conversationIds.has(key.slice(13))
      : !!key.replace(/^new:(chat|work):/, '') &&
        !projectIds.has(key.replace(/^new:(chat|work):/, ''));
    if (missing)
      db.prepare(
        "UPDATE drafts SET revision=revision+1,text='',attachments_json='[]',updated_at=? WHERE owner_key=?",
      ).run(new Date().toISOString(), key);
  }
  for (const row of db.prepare('SELECT DISTINCT owner_key FROM draft_recoveries').all()) {
    const key = String(row.owner_key);
    const missing = key.startsWith('conversation:')
      ? !conversationIds.has(key.slice(13))
      : !!key.replace(/^new:(chat|work):/, '') &&
        !projectIds.has(key.replace(/^new:(chat|work):/, ''));
    if (missing) db.prepare('DELETE FROM draft_recoveries WHERE owner_key=?').run(key);
  }
  const p = state.preferences;
  db.prepare('INSERT INTO preferences VALUES (1,?,?,?,?)').run(
    p.theme,
    p.providerId,
    p.model,
    p.systemPrompt,
  );
}

export function readStateRows(db: DatabaseSync): State {
  if (
    db.prepare("SELECT value FROM metadata WHERE key='stateVersion'").get()?.value !==
    String(STATE_VERSION)
  )
    throw new Error('数据库中的状态格式版本不受支持');
  const projects = db.prepare('SELECT id,name,description FROM projects ORDER BY position').all();
  const conversations = db
    .prepare('SELECT * FROM conversations ORDER BY position')
    .all()
    .map((c) => ({
      id: c.id,
      projectId: c.project_id,
      title: c.title,
      mode: c.mode,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      archived: c.archived === 1,
      messages: db
        .prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY position')
        .all(c.id!)
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          ...(m.status === null ? {} : { status: m.status }),
          ...(m.model === null ? {} : { model: m.model }),
          ...(m.has_attachments === 1
            ? {
                attachments: db
                  .prepare(
                    'SELECT name,content FROM attachments WHERE conversation_id=? AND message_id=? ORDER BY position',
                  )
                  .all(c.id!, m.id!),
              }
            : {}),
        })),
      activities: db
        .prepare('SELECT id,label,at FROM activities WHERE conversation_id=? ORDER BY position')
        .all(c.id!),
    }));
  const providers = db
    .prepare('SELECT * FROM providers ORDER BY position')
    .all()
    .map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.base_url,
      models: db
        .prepare('SELECT name FROM provider_models WHERE provider_id=? ORDER BY position')
        .all(p.id!)
        .map((m) => m.name),
    }));
  const p = db.prepare('SELECT * FROM preferences WHERE singleton=1').get();
  return decodeState({
    schemaVersion: STATE_VERSION,
    projects,
    conversations,
    providers,
    preferences: p && {
      theme: p.theme,
      providerId: p.provider_id,
      model: p.model,
      systemPrompt: p.system_prompt,
    },
  });
}
