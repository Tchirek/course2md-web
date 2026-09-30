import { spawnSync } from 'node:child_process';
const python = process.env.C2MD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['tests/shared-asr.test.py'], { stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
