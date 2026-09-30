// Stopping the helper and the model services it started (uninstalling, moving the data directory).
import { spawnSync } from 'node:child_process';

const SERVICES = ['fast-asr-server.mjs', 'local-asr.py', 'local-polish.py', 'launch-local-polish.mjs', 'llama-server'];

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
