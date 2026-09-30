// Stopping the helper and the model services it started (uninstalling, moving the data directory).
import { spawnSync } from 'node:child_process';

// 不按名字停 llama-server：原版 course2md 也用它。本项目的 llama-server 随各自的 Python 父进程退出（service_lifecycle.py）
const SERVICES = ['fast-asr-server.mjs', 'local-asr.py', 'qwen-asr.py', 'local-polish.py', 'launch-local-polish.mjs'];

/** Stops the helper and its services, matched by their command lines. */
export function stopServices() {
  if (process.platform === 'win32') {
    const pattern = SERVICES.map((name) => name.replaceAll('.', '\\.')).join('|');
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: 'ignore' });
  } else {
    for (const name of SERVICES) spawnSync('pkill', ['-f', name], { stdio: 'ignore' });
  }
}
