"""Prepare a per-user Unix helper; registration/model sharing stays in install-local-asr.mjs."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

base = Path.home() / 'Library/Application Support/course2md' if sys.platform == 'darwin' else Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'course2md'
data = Path(os.environ.get('C2MD_DATA_DIR', base))
isolated = bool(os.environ.get('C2MD_DATA_DIR'))
if not os.environ.get('C2MD_DATA_DIR'):
    try:
        chosen = Path(json.loads((base / 'location.json').read_text())['dir'])
        if chosen.is_absolute():
            data = chosen
    except (OSError, ValueError, KeyError, TypeError):
        pass
os.environ['C2MD_DATA_DIR'] = str(data)
os.environ['C2MD_PYTHON'] = sys.executable
# Portable Python uses the OS trust store on macOS, including after browser/autostart launches.
if sys.platform == 'darwin' and Path('/etc/ssl/cert.pem').exists():
    os.environ.setdefault('SSL_CERT_FILE', '/etc/ssl/cert.pem')
from runtime_download import extract_archive, file_lock, llama_platform, pinned_download

tools = Path(__file__).parent
pins = json.loads((tools / 'bootstrap-pins.json').read_text())[llama_platform()]
cache = data / 'bootstrap'
binary = data / 'bin'
binary.mkdir(parents=True, exist_ok=True)
cache.mkdir(parents=True, exist_ok=True)
os.environ['PATH'] = str(binary) + os.pathsep + os.environ.get('PATH', '')


def download(pin):
    return pinned_download(pin['url'], cache / pin['url'].rsplit('/', 1)[-1], pin['sha256'], '正在准备 MizoreLink 运行环境')


with file_lock(cache / '.setup.lock'):
    node = None
    for candidate in (os.environ.get('C2MD_NODE'), shutil.which('node'), str(cache / pins['node']['binary'])):
        if not candidate:
            continue
        try:
            if int(subprocess.check_output([candidate, '-p', 'process.versions.node.split(".")[0]'], text=True).strip()) >= 22:
                node = candidate
                break
        except (OSError, ValueError, TypeError, subprocess.CalledProcessError):
            pass
    if not node:
        extract_archive(download(pins['node']), cache)
        node = str(cache / pins['node']['binary'])
        Path(node).chmod(0o755)
    os.environ['PATH'] = str(Path(node).parent) + os.pathsep + os.environ['PATH']
    for name in ('ffmpeg', 'ffprobe', 'yt-dlp'):
        existing = shutil.which(name)
        if existing and subprocess.run([existing, '--version' if name == 'yt-dlp' else '-version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            continue
        pin = pins['yt-dlp' if name == 'yt-dlp' else name]
        archive = download(pin)
        if name == 'yt-dlp':
            shutil.copy2(archive, binary / name)
        else:
            target = cache / ('media-' + pin['sha256'][:12])
            if not target.exists() or not next(target.rglob(name), None):
                extract_archive(archive, target)
            shutil.copy2(next(target.rglob(name)), binary / name)
        (binary / name).chmod(0o755)
        subprocess.run([str(binary / name), '--version' if name == 'yt-dlp' else '-version'], check=True, stdout=subprocess.DEVNULL)
    (data / 'runtime.json').write_text(json.dumps({'python': sys.executable}) + '\n')
    deployed = data / 'helper/tools'
    deployed.mkdir(parents=True, exist_ok=True)
    for source in tools.iterdir():
        if source.suffix in ('.mjs', '.py', '.cs', '.json', '.ps1') and source.resolve() != (deployed / source.name).resolve():
            shutil.copy2(source, deployed / source.name)
    # The real install uses the user's saved data directory; C2MD_DATA_DIR must not suppress shared model configuration.
    if not isolated:
        os.environ.pop('C2MD_DATA_DIR', None)
    subprocess.run([node, str(deployed / 'install-local-asr.mjs'), *sys.argv[1:]], check=True)
