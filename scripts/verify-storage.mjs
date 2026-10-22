import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const electron = require('electron');
const electronVersion = require('electron/package.json').version;
const environment = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.CHATWORKER_PROBE_PACKAGED;

function run(label, executable, args, env = environment) {
  console.log(`\n${label}`);
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${label} failed (exit ${result.status}, signal ${result.signal})`);
}

const staging = mkdtempSync(join(tmpdir(), 'chatworker-storage-package-'));
try {
  const compiled = join(staging, 'compiled');
  run('Compile storage verification fixtures', process.execPath, [
    require.resolve('typescript/bin/tsc'),
    '-p',
    'tsconfig.storage-probe.json',
    '--noEmit',
    'false',
    '--outDir',
    compiled,
  ]);
  const project = join(staging, 'app');
  const output = join(staging, 'packaged');
  mkdirSync(project);
  cpSync(compiled, project, { recursive: true });
  cpSync(join(root, 'node_modules/zod'), join(project, 'node_modules/zod'), { recursive: true });
  cpSync(join(root, 'scripts/storage-probe-main.mjs'), join(project, 'main.mjs'));
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'chatworker-storage-probe',
      version: '0.0.0',
      private: true,
      description: 'Isolated SQLite compatibility verification',
      author: 'ChatWorker contributors',
      type: 'module',
      main: 'main.mjs',
      dependencies: { zod: require('zod/package.json').version },
    }),
  );

  run('SQLite in Node', process.execPath, [join(project, 'main.mjs')]);
  run('SQLite in Electron main', electron, [project]);

  const config = join(staging, 'builder.json');
  writeFileSync(
    config,
    JSON.stringify({
      appId: 'com.chatworker.storage-probe',
      productName: 'ChatWorkerStorageProbe',
      executableName: 'chatworker-storage-probe',
      asar: true,
      npmRebuild: false,
      electronVersion,
      electronDist: join(dirname(require.resolve('electron/package.json')), 'dist'),
      directories: { output },
      files: ['main.mjs', 'package.json', 'packages/**/*', 'tests/**/*', 'apps/**/*'],
      mac: { identity: '-' },
      afterPack: join(root, 'scripts/after-pack.cjs'),
    }),
  );
  run('Package isolated Electron application', process.execPath, [
    join(root, 'node_modules/electron-builder/cli.js'),
    '--projectDir',
    project,
    '--dir',
    '--config',
    config,
  ]);

  let binary;
  let archive;
  if (process.platform === 'darwin') {
    const platformOutput = join(output, process.arch === 'x64' ? 'mac' : `mac-${process.arch}`);
    const bundles = readdirSync(platformOutput).filter((name) => name.endsWith('.app'));
    if (bundles.length !== 1) throw new Error('Expected exactly one packaged macOS application');
    const bundle = join(platformOutput, bundles[0], 'Contents');
    binary = join(bundle, 'MacOS', 'chatworker-storage-probe');
    archive = join(bundle, 'Resources', 'app.asar');
  } else {
    const folder =
      process.platform === 'win32'
        ? process.arch === 'x64'
          ? 'win-unpacked'
          : `win-${process.arch}-unpacked`
        : process.arch === 'x64'
          ? 'linux-unpacked'
          : `linux-${process.arch}-unpacked`;
    binary = join(
      output,
      folder,
      `chatworker-storage-probe${process.platform === 'win32' ? '.exe' : ''}`,
    );
    archive = join(output, folder, 'resources', 'app.asar');
  }
  if (!existsSync(archive)) throw new Error('Packaged app.asar was not produced');
  run('SQLite in packaged Electron application (ASAR)', binary, [], {
    ...environment,
    CHATWORKER_PROBE_PACKAGED: '1',
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
}
