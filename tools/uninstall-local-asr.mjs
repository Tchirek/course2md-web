// Remove the browser connection. CLI binaries, shared models and course libraries are untouched.
//
// npm run local:uninstall            unregister the connection
// npm run local:uninstall -- --purge also remove transport files and temporary jobs
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_PARTS, LOCATION_FILE, dataDir, defaultDataDir } from './helper-data.mjs';
import { unregisterHost } from './host-registration.mjs';
import { stopServices } from './services.mjs';

const purge = process.argv.includes('--purge');

await stopServices();
const removed = unregisterHost();
if (purge) {
  for (const dir of transportDirs()) {
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  // Forget only the transport's chosen location.
  rmSync(path.join(defaultDataDir(), LOCATION_FILE), { force: true });
}
for (const item of removed) process.stdout.write(`已删除：${item}\n`);
process.stdout.write('MizoreLink 已移除，course2md 的模型、配置与课程库保留。\n');

/**
 * This project's transport files in the selected and default data directories.
 */
function transportDirs() {
  const dirs = [];
  for (const base of new Set([dataDir(), defaultDataDir()])) {
    for (const name of DATA_PARTS) dirs.push(path.join(base, name));
  }
  return dirs;
}
