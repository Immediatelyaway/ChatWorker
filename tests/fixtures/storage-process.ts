import { StateDatabase } from '../../packages/storage/state-database.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const [, , directory, mode, phase] = process.argv;
const database = StateDatabase.open(directory, {
  migrateLegacy: true,
  onMigrationPhase: (current) => {
    if (mode === 'crash' && current === phase) process.kill(process.pid, 'SIGKILL');
  },
});
if (mode === 'write-crash') {
  database.close();
  const raw = new DatabaseSync(join(directory, 'state.sqlite'));
  raw.exec(
    "PRAGMA cache_size=1; BEGIN IMMEDIATE; UPDATE projects SET name='未提交'; UPDATE projects SET description=printf('%.*c',100000,'x');",
  );
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'hold') {
  process.stdout.write('ready\n');
  setInterval(() => {}, 1_000);
} else database.close();
