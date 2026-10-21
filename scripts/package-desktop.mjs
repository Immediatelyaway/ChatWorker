import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const staging = mkdtempSync(join(tmpdir(), 'chatworker-package-'));
const output = resolve('release');
mkdirSync(output, { recursive: true });
const args = [
  'node_modules/electron-builder/cli.js',
  '--dir',
  `--config.directories.output=${staging}`,
];
if (existsSync('node_modules/electron/dist'))
  args.push(`--config.electronDist=${resolve('node_modules/electron/dist')}`);
if (process.platform === 'darwin') args.push('--config.mac.identity=-');
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`Packaging failed; diagnostic files: ${staging}`);
  process.exit(result.status || 1);
}
if (process.platform === 'darwin') {
  const folder = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  const archive = join(output, `ChatWorker-mac-${process.arch}.zip`);
  const zip = spawnSync(
    '/usr/bin/ditto',
    ['-c', '-k', '--keepParent', join(staging, folder, 'ChatWorker.app'), archive],
    { stdio: 'inherit' },
  );
  if (zip.status !== 0) process.exit(zip.status || 1);
  console.log(`Desktop application: ${archive}`);
} else {
  cpSync(staging, output, { recursive: true });
  console.log(`Desktop application: ${output}`);
}
rmSync(staging, { recursive: true, force: true });
