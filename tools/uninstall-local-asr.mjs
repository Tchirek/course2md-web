// Removes the local helper: stops its services, undoes the browser registration and autostart,
// and deletes the host files. Downloaded models (several GB) are kept unless --purge is given,
// so a later reinstall does not download them again.
//
// npm run local:uninstall            keep models
// npm run local:uninstall -- --purge also delete models and runtimes
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './helper-data.mjs';
import { unregisterHost } from './host-registration.mjs';

const purge = process.argv.includes('--purge');
const SERVICES = ['fast-asr-server.mjs', 'local-asr.py', 'local-polish.py', 'launch-local-polish.mjs', 'llama-server'];

stopServices();
const removed = unregisterHost();
if (purge) {
  for (const dir of modelDirs()) {
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
}
for (const item of removed) process.stdout.write(`已删除：${item}\n`);
process.stdout.write(purge
  ? '本机助手已卸载，下载的模型与运行库也已删除。\n'
  : '本机助手已卸载。下载的模型与运行库仍保留，重装时无须再下；要一并删除请运行 npm run local:uninstall -- --purge。\n');

/** Stop the helper and the model services it started, matched by their command lines. */
function stopServices() {
  if (process.platform === 'win32') {
    const pattern = SERVICES.map((name) => name.replaceAll('.', '\\.')).join('|');
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: 'ignore' });
  } else {
    for (const name of SERVICES) spawnSync('pkill', ['-f', name], { stdio: 'ignore' });
  }
}

/** Where models and runtimes are downloaded (see local-asr.py and launch-local-polish.mjs). */
function modelDirs() {
  const dirs = [path.join(dataDir(), 'models'), path.join(dataDir(), 'polish')];
  if (process.platform !== 'win32') dirs.push(path.join(os.homedir(), '.cache', 'course2md'));
  if (process.env.C2MD_POLISH_HOME) dirs.push(process.env.C2MD_POLISH_HOME);
  if (process.platform === 'win32') dirs.push('Q:\\c2md-data\\polish');
  return dirs;
}
