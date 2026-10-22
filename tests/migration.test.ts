import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  renameSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { StateDatabase, type MigrationPhase } from '../packages/storage/state-database.js';
import { Storage } from '../apps/server/src/storage.js';
import { decodeState, initialState } from '../apps/server/src/state-schema.js';

const fixture = fileURLToPath(new URL('./fixtures/storage-process.ts', import.meta.url));
const temporary = () => mkdtempSync(join(tmpdir(), 'chatworker-migration-'));
function legacy(dir: string) {
  const state = initialState();
  state.projects.push({ id: 'p', name: '研究项目', description: '保留中文 🐈' });
  state.conversations.push({
    id: 'c',
    title: '原会话',
    projectId: 'p',
    mode: 'work',
    archived: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activities: [{ id: 'a', at: new Date().toISOString(), label: '旧活动文字' }],
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: '第一条',
        createdAt: new Date().toISOString(),
        attachments: [{ name: '资料.md', content: '附件\n原文' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '未完成',
        status: 'streaming',
        model: '旧模型',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'm3',
        role: 'user',
        content: '第二条',
        createdAt: new Date().toISOString(),
        attachments: [],
      },
    ],
  });
  const raw: Record<string, unknown> = { ...state };
  delete raw.schemaVersion;
  const bytes = Buffer.from(JSON.stringify(raw, null, 2));
  writeFileSync(join(dir, 'state.json'), bytes);
  return { state: decodeState(raw), bytes };
}

test('offline migration preserves IDs, order and immutable backup; restart preserves storeId and never falls back', async () => {
  const dir = temporary();
  try {
    const { state, bytes } = legacy(dir);
    await assert.rejects(Storage.open(dir), { code: 'LEGACY_MIGRATION_REQUIRED' });
    assert.equal(existsSync(join(dir, 'migration.json')), false);
    const store = await Storage.open(dir, { migrateLegacy: true });
    const id = store.storeId;
    assert.deepEqual(store.state.projects, state.projects);
    assert.deepEqual(
      store.state.conversations[0].messages.map((m) => m.id),
      ['m1', 'm2', 'm3'],
    );
    assert.equal(store.state.conversations[0].messages[1].status, 'failed');
    assert.deepEqual(store.state.conversations[0].messages[0], state.conversations[0].messages[0]);
    assert.equal(store.state.conversations[0].activities[0].label, '旧活动文字');
    assert.equal(store.state.conversations[0].archived, true);
    await store.update((next) => {
      next.projects[0].name = '数据库中的修改';
    });
    await store.close();
    assert.deepEqual(readFileSync(join(dir, 'state.json')), bytes);
    const backup = readdirSync(dir).find((file) => file.startsWith('state.json.backup-'))!;
    assert.equal(backup, 'state.json.backup-' + createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(readFileSync(join(dir, backup)), bytes);
    const reopened = await Storage.open(dir);
    assert.equal(reopened.storeId, id);
    assert.equal(reopened.state.projects[0].name, '数据库中的修改');
    assert.equal(reopened.state.conversations[0].activities.length, 2);
    await reopened.close();
    renameSync(join(dir, 'state.sqlite'), join(dir, 'saved.sqlite'));
    await assert.rejects(Storage.open(dir), { code: 'DATABASE_MISSING' });
    assert.equal(existsSync(join(dir, 'state.sqlite')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid JSON and future/corrupt databases are rejected without replacing bytes', async () => {
  for (const bytes of ['{broken', JSON.stringify({ ...initialState(), schemaVersion: 99 })]) {
    const dir = temporary();
    try {
      writeFileSync(join(dir, 'state.json'), bytes);
      await assert.rejects(Storage.open(dir, { migrateLegacy: true }));
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes);
      assert.equal(existsSync(join(dir, 'state.sqlite')), false);
      assert.equal(existsSync(join(dir, 'migration.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const kind of ['future', 'corrupt', 'wal']) {
    const dir = temporary();
    try {
      const store = await Storage.open(dir);
      await store.close();
      const file = join(dir, 'state.sqlite');
      const bytes = readFileSync(file);
      if (kind === 'future') bytes.writeUInt32BE(99, 60);
      else if (kind === 'wal') {
        bytes[18] = 2;
        bytes[19] = 2;
      } else bytes.fill(0, 0, 100);
      writeFileSync(file, bytes);
      await assert.rejects(Storage.open(dir));
      assert.deepEqual(readFileSync(file), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('SIGKILL at each migration boundary can resume without losing or duplicating records', async () => {
  const phases: MigrationPhase[] = [
    'planned',
    'backup-created',
    'importing',
    'import-committed',
    'before-switch',
    'after-switch',
    'ready',
  ];
  for (const phase of phases) {
    const dir = temporary();
    try {
      const { state, bytes } = legacy(dir);
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', fixture, dir, 'crash', phase],
        { timeout: 15_000, encoding: 'utf8' },
      );
      assert.equal(result.signal, 'SIGKILL', `${phase}: ${result.stderr}`);
      const store = await Storage.open(dir);
      assert.deepEqual(store.state.projects, state.projects, phase);
      assert.equal(store.state.conversations.length, 1, phase);
      assert.equal(store.state.conversations[0].messages.length, 3, phase);
      assert.equal(store.state.conversations[0].messages[1].status, 'failed', phase);
      await store.close();
      assert.deepEqual(readFileSync(join(dir, 'state.json')), bytes, phase);
      assert.equal(
        readdirSync(dir).filter(
          (file) => file.startsWith('state.json.backup-') && !file.endsWith('.tmp'),
        ).length,
        1,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a second process is refused and the OS releases its lock after process death', async () => {
  const dir = temporary();
  const owner = spawn(process.execPath, ['--import', 'tsx', fixture, dir, 'hold'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(owner, 'exit');
  try {
    await Promise.race([
      once(owner.stdout!, 'data'),
      exited.then(() => {
        throw new Error('lock owner exited early');
      }),
    ]);
    await assert.rejects(Storage.open(dir), { code: 'STORE_BUSY' });
    owner.kill('SIGKILL');
    await exited;
    const store = await Storage.open(dir);
    await store.close();
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill('SIGKILL');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hot rollback journal restores the last committed snapshot after a writer crash', async () => {
  const dir = temporary();
  try {
    const store = await Storage.open(dir);
    await store.update((state) => {
      state.projects.push({ id: 'p', name: '已提交', description: '原文' });
    });
    await store.close();
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture, dir, 'write-crash'], {
      timeout: 15_000,
      encoding: 'utf8',
    });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    assert.ok(existsSync(join(dir, 'state.sqlite-journal')));
    const reopened = await Storage.open(dir);
    try {
      assert.deepEqual(reopened.state.projects, [{ id: 'p', name: '已提交', description: '原文' }]);
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changed migration source or corrupt backup never activates a database', () => {
  for (const change of ['source', 'backup']) {
    const dir = temporary();
    try {
      legacy(dir);
      assert.throws(
        () =>
          StateDatabase.open(dir, {
            migrateLegacy: true,
            onMigrationPhase: (phase) => {
              if (phase === 'backup-created') throw new Error('simulated interruption');
            },
          }),
        /simulated interruption/,
      );
      const target =
        change === 'source'
          ? 'state.json'
          : readdirSync(dir).find((file) => file.startsWith('state.json.backup-'))!;
      if (change === 'backup') {
        /* backup is intentionally read-only */
        chmodSync(join(dir, target), 0o600);
      }
      writeFileSync(join(dir, target), JSON.stringify(initialState()));
      assert.throws(() => StateDatabase.open(dir));
      assert.equal(existsSync(join(dir, 'state.sqlite')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
