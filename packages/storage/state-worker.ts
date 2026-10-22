import { parentPort, workerData } from 'node:worker_threads';
import { StateDatabase } from './state-database.js';
import type { State } from '../shared/types.js';

const port = parentPort!;
function failure(error: unknown) {
  return {
    message: error instanceof Error ? error.message : '存储操作失败',
    code:
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'STORAGE_ERROR',
  };
}
try {
  const database = StateDatabase.open(workerData.directory, {
    migrateLegacy: workerData.migrateLegacy,
  });
  port.on(
    'message',
    (request: { id: number; operation: 'load' | 'save' | 'close'; state?: State }) => {
      try {
        let value;
        if (request.operation === 'load') value = database.load();
        else if (request.operation === 'save') database.save(request.state!);
        else if (request.operation === 'close') database.close();
        else throw new Error('未知存储操作');
        port.postMessage({ id: request.id, value });
        if (request.operation === 'close') port.close();
      } catch (error) {
        port.postMessage({ id: request.id, error: failure(error) });
      }
    },
  );
  port.postMessage({ ready: true, storeId: database.storeId });
} catch (error) {
  port.postMessage({ ready: false, error: failure(error) });
  port.close();
}
