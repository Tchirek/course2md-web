// Platform installers embed the same checked helper archive. No installer SDK or npm runtime dependency.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ZIP = resolve(process.argv[2] || '');
const version = /course2md-helper-(\d+\.\d+\.\d+)\.zip$/.exec(ZIP)?.[1];
if (!version) throw new Error('Usage: node tools/build-installer.mjs <course2md-helper-x.y.z.zip>');
const dist = dirname(ZIP);
const scratch = mkdtempSync(join(tmpdir(), 'course2md-installer-'));
const run = (exe, args) => {
  const result = spawnSync(exe, args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`${exe} failed: ${result.error || result.status}`);
};
try {
  if (process.platform === 'win32') {
    const csc = ['Framework64', 'Framework'].map((name) => join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')).find(existsSync);
    if (!csc) throw new Error('Windows .NET Framework compiler missing');
    const exe = join(dist, `course2md-helper-${version}-windows.exe`);
    run(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${exe}`, `/resource:${ZIP},helper.zip`,
      '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll', join(ROOT, 'tools/helper-setup.cs')]);
    const unpacked = join(scratch, 'unpacked');
    run(exe, ['--extract', unpacked]);
    if (!existsSync(join(unpacked, 'tools/install-helper.ps1'))) throw new Error('Installer payload missing');
  } else if (process.platform === 'darwin') {
    const scripts = join(scratch, 'scripts');
    mkdirSync(scripts);
    // Scripts-only pkg: payload is deployed into the logged-in user's chosen directory by the same bootstrap as Linux.
    writeFileSync(join(scripts, 'setup.run'), unixInstaller());
    writeFileSync(join(scripts, 'postinstall'), `#!/bin/sh
set -eu
task_user=$(stat -f '%Su' /dev/console)
case "$task_user" in root|loginwindow|_mbsetupuser) task_user="\${SUDO_USER:-}";; esac
[ -n "$task_user" ] && [ "$task_user" != root ] || { echo 'Please install from a logged-in user session.' >&2; exit 1; }
task_stage=$(mktemp -d /tmp/course2md-pkg.XXXXXX)
trap 'rm -rf "$task_stage"' EXIT HUP INT TERM
cp "$(dirname "$0")/setup.run" "$task_stage/setup.run"
chown "$task_user" "$task_stage" "$task_stage/setup.run"
/usr/bin/sudo -H -u "$task_user" /bin/sh "$task_stage/setup.run"
`);
    chmodSync(join(scripts, 'postinstall'), 0o755);
    run('/bin/sh', ['-n', join(scripts, 'postinstall')]);
    run('/bin/sh', ['-n', join(scripts, 'setup.run')]);
    run('/usr/bin/pkgbuild', ['--nopayload', '--scripts', scripts, '--identifier', 'io.github.tchirek.course2md.helper', '--version', version, join(dist, `course2md-helper-${version}-macos.pkg`)]);
  } else {
    const output = join(dist, `course2md-helper-${version}-linux.run`);
    writeFileSync(output, unixInstaller());
    chmodSync(output, 0o755);
    run('/bin/sh', ['-n', output]);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

function unixInstaller() {
  const pins = JSON.parse(readFileSync(join(ROOT, 'tools/bootstrap-pins.json'), 'utf8'));
  const cases = Object.entries(pins).map(([key, pin]) => {
    const [os, arch] = key.split('-');
    const pattern = `${os === 'darwin' ? 'Darwin' : 'Linux'}-${arch === 'arm64' ? 'arm64|'+ (os === 'darwin' ? 'Darwin' : 'Linux') + '-aarch64' : 'x86_64'}`;
    return `  ${pattern}) task_url='${pin.python.url}'; task_hash='${pin.python.sha256}' ;;`;
  }).join('\n');
  const payload = readFileSync(ZIP);
  const digest = createHash('sha256').update(payload).digest('hex');
  return `#!/bin/sh
# course2md ${version}: self-contained helper installer; downloads only missing runtimes.
set -eu
umask 077
case "$(uname -s)-$(uname -m)" in
${cases}
  *) echo 'This installer supports macOS/Linux on x86_64 and ARM64.' >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Darwin) task_data="$HOME/Library/Application Support/course2md" ;;
  *) task_data="\${XDG_DATA_HOME:-$HOME/.local/share}/course2md" ;;
esac
task_cache="\${C2MD_DATA_DIR:-$task_data}/bootstrap"
mkdir -p "$task_cache"
task_python="\${C2MD_PYTHON:-python3}"
if [ "$(uname -s)" = Darwin ] && [ "$(command -v "$task_python" || true)" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then task_python="$task_cache/python/bin/python3"; fi
if ! "$task_python" -c 'import sys, tomllib, venv; assert sys.version_info >= (3, 11)' 2>/dev/null; then
  task_python="$task_cache/python/bin/python3"
  if ! "$task_python" -c 'import tomllib, venv' 2>/dev/null; then
    echo 'Preparing Python…'
    curl --fail --location --retry 3 "$task_url" -o "$task_cache/python.tar.gz.download"
    if command -v sha256sum >/dev/null 2>&1; then task_actual=$(sha256sum "$task_cache/python.tar.gz.download"); else task_actual=$(shasum -a 256 "$task_cache/python.tar.gz.download"); fi
    [ "\${task_actual%% *}" = "$task_hash" ] || { echo 'Python checksum failed.' >&2; exit 1; }
    mv "$task_cache/python.tar.gz.download" "$task_cache/python.tar.gz"
    tar -xzf "$task_cache/python.tar.gz" -C "$task_cache"
  fi
fi
task_stage=$(mktemp -d "\${TMPDIR:-/tmp}/course2md-setup.XXXXXX")
trap 'rm -rf "$task_stage"' EXIT HUP INT TERM
cat > "$task_stage/payload.base64" <<'C2MD_PAYLOAD'
${payload.toString('base64').match(/.{1,76}/g).join('\n')}
C2MD_PAYLOAD
"$task_python" - "$task_stage" <<'C2MD_UNPACK'
import base64, hashlib, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
payload = base64.b64decode((root / 'payload.base64').read_bytes())
if hashlib.sha256(payload).hexdigest() != '${digest}':
    raise RuntimeError('Installer payload checksum failed')
(root / 'helper.zip').write_bytes(payload)
with zipfile.ZipFile(root / 'helper.zip') as archive:
    for name in archive.namelist():
        if name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts or '\\x5c' in name:
            raise RuntimeError('Invalid installer archive path')
    archive.extractall(root)
C2MD_UNPACK
echo 'Installing course2md helper…'
"$task_python" "$task_stage/tools/install-helper.py" "$@"
echo 'Ready. Return to course2md in your browser.'
exit 0
`;
}
