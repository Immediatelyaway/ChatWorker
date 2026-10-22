import { resolve } from 'node:path';
import { Storage } from './storage.js';

const directory = process.argv[2] || process.env.CHATWORKER_DATA_DIR;
if (!directory || process.argv.length > 3) {
  console.error(
    '用法：npm run storage:migrate -- <资料目录>。请先关闭使用该目录的旧版桌面和 Web 服务。',
  );
  process.exitCode = 1;
} else {
  const store = await Storage.open(resolve(directory), { migrateLegacy: true });
  try {
    console.log(`迁移已完成并校验，资料库 ID：${store.storeId}。旧文件与迁移备份已保留。`);
  } finally {
    await store.close();
  }
}
