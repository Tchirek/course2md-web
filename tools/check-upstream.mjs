import { spawnSync } from 'node:child_process';
if (!process.env.C2MD_UPSTREAM_EXE) {
  console.error('请设置 C2MD_UPSTREAM_EXE 为 course2md 2.0 CLI 的完整路径。此检查只处理临时测试课程。');
  process.exit(1);
}
const python = process.env.C2MD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['tests/desktop-sync.test.py', 'DesktopSyncTest.test_latest_engine_reprocesses_and_shares_publish_lock'], {
  windowsHide: true, stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
