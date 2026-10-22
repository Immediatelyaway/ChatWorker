import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySqliteContract } from './tests/helpers/sqlite-contract.js';
import { verifyStorageWorkerContract } from './tests/helpers/storage-worker-contract.js';
import { openSqliteDatabase, hasWalResetFix } from './packages/storage/sqlite.js';

const directory = mkdtempSync(join(tmpdir(), 'chatworker-storage-probe-data-'));
let app;
let exitCode = 0;
try {
  if (process.versions.electron) {
    ({ app } = await import('electron'));
    // This test app neither opens a window nor uses ChatWorker's user data directory.
    app.setPath('userData', directory);
    app.setPath('sessionData', directory);
    assert.equal(process.type, 'browser');
    assert.equal(app.isPackaged, process.env.CHATWORKER_PROBE_PACKAGED === '1');
    if (app.isPackaged) assert.match(app.getAppPath(), /app\.asar$/);
  }
  const result = verifySqliteContract(directory);
  const workerChecks = await verifyStorageWorkerContract(directory);
  let wal;
  if (hasWalResetFix(result.sqlite)) {
    wal = verifySqliteContract(directory, 'wal');
  } else {
    assert.throws(
      () => openSqliteDatabase(join(directory, 'wal.sqlite'), { journalMode: 'wal' }),
      /WAL-reset fix/,
    );
    wal = 'blocked: runtime lacks WAL-reset fix';
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      runtime: app ? (app.isPackaged ? 'electron-packaged' : 'electron-main') : 'node',
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      ...result,
      workerChecks,
      wal,
    }),
  );
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
  if (app) app.exit(exitCode);
  else process.exitCode = exitCode;
}
