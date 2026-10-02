// Removes MizoreLink: stops its services, undoes the browser registration and autostart,
// and deletes the host files. Downloaded runtimes and polish models are kept unless --purge is given,
// so a later reinstall does not download them again. The speech model is never deleted here: it is
// shared with the original course2md, which may be using it.
//
// npm run local:uninstall            keep runtimes and models
// npm run local:uninstall -- --purge also delete this project's runtimes and polish models
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_PARTS, LOCATION_FILE, dataDir, defaultDataDir } from './helper-data.mjs';
import { unregisterHost } from './host-registration.mjs';
import { stopServices } from './services.mjs';

const purge = process.argv.includes('--purge');

stopServices();
const removed = unregisterHost();
if (purge) {
  for (const dir of modelDirs()) {
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  // the data directory chosen with --data-dir is forgotten along with everything in it
  rmSync(path.join(defaultDataDir(), LOCATION_FILE), { force: true });
}
for (const item of removed) process.stdout.write(`已删除：${item}\n`);
process.stdout.write(purge
  ? 'MizoreLink 已卸载，专用运行库已删除；共享模型与 course2md 配置已保留。\n'
  : 'MizoreLink 已卸载。下载的模型与运行库仍保留，重装时无须再下；要一并删除请运行 npm run local:uninstall -- --purge。\n');

/**
 * Where this project's runtimes are downloaded: the chosen data directory and, if the data was moved
 * with --data-dir, whatever is still left in the default one.
 */
function modelDirs() {
  const dirs = [];
  for (const base of new Set([dataDir(), defaultDataDir()])) {
    for (const name of DATA_PARTS) dirs.push(path.join(base, name));
  }
  if (process.env.C2MD_POLISH_HOME) dirs.push(process.env.C2MD_POLISH_HOME);
  return dirs;
}
