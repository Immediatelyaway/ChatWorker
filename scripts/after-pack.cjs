const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
// Finder metadata can make codesign reject a freshly copied local app bundle.
// Remove only Finder/resource-fork metadata, never quarantine or security attributes.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const bundle = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  for (const attribute of ['com.apple.FinderInfo', 'com.apple.ResourceFork']) {
    spawnSync('/usr/bin/xattr', ['-dr', attribute, bundle], { stdio: 'ignore' });
  }
};
