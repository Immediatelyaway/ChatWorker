import { app, BrowserWindow, safeStorage, Menu, dialog } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../dist/apps/server/src/index.js';
import { Storage } from '../../dist/apps/server/src/storage.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (process.env.CHATWORKER_DESKTOP_DATA_DIR) {
  mkdirSync(process.env.CHATWORKER_DESKTOP_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.CHATWORKER_DESKTOP_DATA_DIR);
}
let runtime, window;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  void launch().catch((error) => {
    console.error('ChatWorker startup failed', error);
    dialog.showErrorBox(
      'ChatWorker 无法启动',
      error instanceof Error ? error.message : '请检查本机数据目录',
    );
    app.quit();
  });
}
async function launch() {
  await app.whenReady();
  const dataDir = process.env.CHATWORKER_DESKTOP_DATA_DIR || app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  const vaultPath = join(dataDir, 'credentials.enc.json');
  const secure =
    safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
  const data = new Map();
  if (secure && existsSync(vaultPath))
    try {
      const saved = JSON.parse(readFileSync(vaultPath, 'utf8'));
      for (const [id, value] of Object.entries(saved))
        data.set(id, safeStorage.decryptString(Buffer.from(value, 'base64')));
    } catch {
      console.warn('Saved credentials unavailable; please re-enter keys.');
    }
  const secrets = {
    persistent: secure,
    get: (id) => data.get(id) || '',
    set: (id, value) => {
      value ? data.set(id, value) : data.delete(id);
      if (secure) {
        const encrypted = Object.fromEntries(
          [...data].map(([id, value]) => [id, safeStorage.encryptString(value).toString('base64')]),
        );
        writeFileSync(vaultPath + '.tmp', JSON.stringify(encrypted), { mode: 0o600 });
        renameSync(vaultPath + '.tmp', vaultPath);
      }
    },
  };
  const serverOptions = {
    port: 0,
    dataDir,
    webDir: join(root, 'dist/web'),
    secrets,
    desktop: true,
  };
  try {
    runtime = await startServer(serverOptions);
  } catch (error) {
    if (error.code !== 'LEGACY_MIGRATION_REQUIRED') throw error;
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: '升级本机数据',
      message: '发现旧版会话数据，需要备份并升级后才能使用。',
      detail:
        '请先关闭使用此资料目录的旧版 ChatWorker 和 Web 服务。升级会保留旧文件和独立备份，失败时不会清空会话。',
      buttons: ['备份并升级', '退出'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice.response !== 0) {
      app.quit();
      return;
    }
    const migrated = await Storage.open(dataDir, { migrateLegacy: true });
    await migrated.close();
    runtime = await startServer(serverOptions);
  }
  const origin = `http://127.0.0.1:${runtime.port}`;
  function createWindow() {
    window = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 860,
      minHeight: 620,
      title: 'ChatWorker',
      backgroundColor: '#f1f2f1',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    window.loadURL(origin);
    window.on('closed', () => (window = null));
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'ChatWorker',
        submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
        ],
      },
    ]),
  );
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void runtime.close().finally(() => app.quit());
  });
}
