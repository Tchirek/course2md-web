// Stop the connection, including its active CLI jobs, before reinstalling or uninstalling.
import { spawnSync } from 'node:child_process';
import { readHelperToken } from './helper-data.mjs';

// Migration only: match old Web services, never another course2md instance or model server.
const SERVICES = ['fast-asr-server.mjs', 'local-asr.py', 'qwen-asr.py', 'local-polish.py', 'launch-local-polish.mjs'];

/** Stops the helper and its services, matched by their command lines. */
export async function stopServices() {
  let stopping = false;
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.C2MD_HELPER_PORT || 8766}/shutdown`, {
      method: 'POST', headers: { 'x-c2md-token': readHelperToken() }, signal: AbortSignal.timeout(3000),
    });
    stopping = response.ok;
  } catch { /* An older helper cannot shut down cooperatively. */ }
  if (stopping) {
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await fetch(`http://127.0.0.1:${process.env.C2MD_HELPER_PORT || 8766}/health`, { signal: AbortSignal.timeout(500) });
      } catch { return; }
    }
    throw new Error('CLI 浏览器连接尚未停止');
  }
  if (process.platform === 'win32') {
    const pattern = SERVICES.map((name) => name.replaceAll('.', '\\.')).join('|');
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: 'ignore' });
  } else {
    for (const name of SERVICES) spawnSync('pkill', ['-f', name], { stdio: 'ignore' });
  }
}
