// A lock around installing a runtime into a shared directory.
//
// The helper can be asked to start a service twice at once (two tabs, a double click, the installer
// running while the helper is up). Two pip runs in the same environment uninstall and reinstall
// packages under each other: the one that finishes first then imports half-written packages and
// fails with confusing errors. Only one installer may work in a directory at a time; the others wait.
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';

const STALE_MS = 3 * 3600_000;

/** Whether the process that wrote the lock is still running. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function tryLock(file) {
  try {
    const fd = openSync(file, 'wx');
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // A lock left behind by a process that died (killed, machine restarted) must not block forever
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* being written right now, or unreadable: judge by age alone */ }
  let age = 0;
  try {
    age = Date.now() - statSync(file).mtimeMs;
  } catch {
    return false;
  }
  if ((holder?.pid && !alive(holder.pid)) || age > STALE_MS) {
    rmSync(file, { force: true });
  }
  return false;
}

/**
 * Runs fn while holding the lock file. Waits for another holder to finish; onWait is told once.
 * @template T
 * @param {string} file
 * @param {() => Promise<T>} fn
 * @param {{ onWait?: () => void, timeoutMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withLock(file, fn, { onWait = () => {}, timeoutMs = STALE_MS } = {}) {
  const started = Date.now();
  let told = false;
  while (!tryLock(file)) {
    if (!told) {
      onWait();
      told = true;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`等待安装锁超时：${file}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}
