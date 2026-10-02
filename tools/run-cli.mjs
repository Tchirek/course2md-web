import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPython } from './host-registration.mjs';

const file = process.argv.includes('--check') ? './check-cli.py' : './cli_bridge.py';
const result = spawnSync(findPython(), [fileURLToPath(new URL(file, import.meta.url))], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
