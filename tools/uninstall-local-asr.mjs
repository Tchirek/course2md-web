// Removes the local helper: stops its services, undoes the browser registration and autostart,
// and deletes the host files. Downloaded models (several GB) are kept unless --purge is given,
// so a later reinstall does not download them again.
//
// npm run local:uninstall            keep models
// npm run local:uninstall -- --purge also delete models and runtimes
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
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
  ? '本机助手已卸载，下载的模型与运行库也已删除。\n'
  : '本机助手已卸载。下载的模型与运行库仍保留，重装时无须再下；要一并删除请运行 npm run local:uninstall -- --purge。\n');

/**
 * Where models and runtimes are downloaded: the chosen data directory and, if the data was moved
 * with --data-dir, whatever is still left in the default one.
 */
function modelDirs() {
  const dirs = [];
  for (const base of new Set([dataDir(), defaultDataDir()])) {
    for (const name of DATA_PARTS) dirs.push(path.join(base, name));
  }
  // older versions kept the transcription model under ~/.cache on macOS / Linux
  if (process.platform !== 'win32') dirs.push(path.join(os.homedir(), '.cache', 'course2md'));
  if (process.env.C2MD_POLISH_HOME) dirs.push(process.env.C2MD_POLISH_HOME);
  return dirs;
}
