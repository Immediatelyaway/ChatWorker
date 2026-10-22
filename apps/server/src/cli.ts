import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './index.js';
const webDir = resolve('dist/web');
let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  runtime = await startServer({
    port: Number(process.env.PORT ?? 4317),
    dataDir: process.env.CHATWORKER_DATA_DIR,
    webDir: existsSync(webDir) ? webDir : undefined,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'ChatWorker 启动失败');
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'LEGACY_MIGRATION_REQUIRED'
  )
    console.error('停止旧服务后，运行 npm run storage:migrate -- <资料目录>，然后重新启动。');
  process.exitCode = 1;
}
if (runtime) {
  console.log(`ChatWorker API: http://127.0.0.1:${runtime.port}`);
  for (const event of ['SIGINT', 'SIGTERM'])
    process.on(event, () => {
      void runtime!.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
}
