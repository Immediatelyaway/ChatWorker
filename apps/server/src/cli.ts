import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './index.js';
const webDir = resolve('dist/web');
const runtime = await startServer({
  port: Number(process.env.PORT ?? 4317),
  dataDir: process.env.CHATWORKER_DATA_DIR,
  webDir: existsSync(webDir) ? webDir : undefined,
});
console.log(`ChatWorker API: http://127.0.0.1:${runtime.port}`);
for (const event of ['SIGINT', 'SIGTERM'])
  process.on(event, () => {
    void runtime.close().then(() => process.exit(0));
  });
