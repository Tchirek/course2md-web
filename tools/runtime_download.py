"""Pinned downloads and llama.cpp shared by transcription and polishing."""
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from contextlib import contextmanager
from pathlib import Path
from pins import PINS, VerifiedFiles

ROOT = Path(os.environ.get('C2MD_POLISH_HOME') or Path(os.environ['C2MD_DATA_DIR']) / 'polish')
ROOT.mkdir(parents=True, exist_ok=True)
VERIFIED = VerifiedFiles(ROOT / 'verified.json')

def state(name, message):
    print(json.dumps({'state': name, 'message': message}), flush=True)

@contextmanager
def file_lock(path):
    """OS lock: released even if the downloader is killed; also interoperates with fs2."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'a+b') as handle:
        if sys.platform == 'win32':
            import msvcrt
            while True:
                try:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.2)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if sys.platform == 'win32':
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)

def robust_download(url, target, message):
    """纯 urllib 断点续传下载；hf_hub 的下载后端在本机反复崩溃，不再依赖它。"""
    part = target.with_suffix(target.suffix + '.part')
    request = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(request, timeout=30) as response:
        total = int(response.headers.get('Content-Length') or 0)
    if target.exists() and total and target.stat().st_size == total:
        return target
    failures = 0
    while True:
        done = part.stat().st_size if part.exists() else 0
        if total and done >= total:
            break
        headers = {'Range': f'bytes={done}-'} if done else {}
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                # A server may ignore Range. Restart instead of appending the entire file.
                if done and response.status != 206:
                    done = 0
                elif done and not response.headers.get('Content-Range', '').startswith(f'bytes {done}-'):
                    raise RuntimeError('下载续传位置不符')
                with open(part, 'ab' if done else 'wb') as sink:
                    while True:
                        block = response.read(1 << 20)
                        if not block:
                            break
                        sink.write(block)
            if not total:
                break  # 長さが分からなければ、ストリームの終わりまで読めた時点で完了
            if part.stat().st_size <= done:
                raise RuntimeError('下载没有进展')
        except Exception:
            # 進んでいる限り再開を続け、まったく進まない失敗（回線断、URL 失効）が続いたら諦める
            failures = 0 if part.exists() and part.stat().st_size > done else failures + 1
            if failures >= 10:
                raise RuntimeError(f'{message}失败：连续 {failures} 次没有进展，请检查网络后重试')
            time.sleep(2)
    if total and part.stat().st_size != total:
        raise RuntimeError(f'下载不完整：{part.stat().st_size}/{total}')
    part.replace(target)
    return target


def pinned_download(url, target, digest, message, verified=None, preserve=False):
    """固定版のファイルを取り、SHA-256 を確かめる。合わなければ消して止め、未検証のものは残さない。"""
    verified = verified or VERIFIED
    if verified.matches(target, digest):
        return target
    if preserve and target.exists():
        raise RuntimeError(f'共享模型与固定版本不符，已保留原文件：{target}；请使用 C2MD_MODEL_DIR 指定独立目录')
    state('downloading', message)
    target.parent.mkdir(parents=True, exist_ok=True)
    # 大きさが同じで中身の違う古いファイルを「取得済み」と見なさないよう、先に消す
    target.unlink(missing_ok=True)
    robust_download(url, target, message)
    if not verified.matches(target, digest):
        target.unlink(missing_ok=True)
        raise RuntimeError(f'{target.name} 与固定版本的 SHA-256 不符，已删除；请检查网络后重试')
    return target


def llama_platform():
    """runtime-pins.json の llama.cpp 資産の鍵（win32-x64、darwin-arm64、linux-x64 など）。

    Windows は CUDA 12.4（本体と cudart の 2 つの zip）、macOS は公式の Metal 版、
    Linux は既定で CPU 版（NVIDIA 向けの ubuntu-cuda 版もあるが、ここでは控えめに）。
    """
    machine = platform.machine().lower()
    arch = 'arm64' if machine in ('arm64', 'aarch64') else 'x64' if machine in ('x86_64', 'amd64', 'x64') else machine
    system = 'win32' if sys.platform == 'win32' else 'darwin' if sys.platform == 'darwin' else 'linux'
    return f'{system}-{arch}'


def built_from(binary, tag):
    """既存の llama-server が固定版（build 番号）そのものか。"""
    try:
        result = subprocess.run([str(binary), '--version'], capture_output=True, text=True, timeout=30)
    except Exception:
        return False
    return f'build {tag.lstrip("b")},' in result.stdout + result.stderr


def prepare_llama():
    with file_lock(ROOT / '.llama-install.lock'):
        return _prepare_llama()


def _prepare_llama():
    pin = PINS['llama.cpp']
    key = llama_platform()
    assets = pin['assets'].get(key)
    if not assets:
        raise RuntimeError(f'没有适用于 {key} 的 llama.cpp 运行库')
    binary_name = 'llama-server.exe' if sys.platform == 'win32' else 'llama-server'
    installed = shutil.which(binary_name)
    if installed and built_from(installed, pin['tag']):
        return Path(installed), pin['gpu_layers'].get(key, 0)
    target = ROOT / 'llama'
    stamp = target / '.pinned-tag'
    binary = next(target.rglob(binary_name), None) if target.exists() else None
    current = stamp.read_text().strip() if stamp.exists() else ''
    if binary is not None and not current and built_from(binary, pin['tag']):
        # 以前「最新版」として入れたものが固定版そのものなら印を付けるだけにし、数百 MB を取り直さない
        stamp.write_text(pin['tag'])
        current = pin['tag']
    if binary is None or current != pin['tag']:
        shutil.rmtree(target, ignore_errors=True)
        target.mkdir(parents=True, exist_ok=True)
        for asset in assets:
            archive = ROOT / asset['name']
            pinned_download(f'https://github.com/{pin["repo"]}/releases/download/{pin["tag"]}/{asset["name"]}',
                            archive, asset['sha256'], '正在准备共享 llama.cpp 运行库')
            extract_archive(archive, target)
            archive.unlink()
        binary = next(target.rglob(binary_name), None)
        if binary is None:
            raise RuntimeError(f'运行库缺少 {binary_name}')
        if sys.platform != 'win32':
            # zip/tar の展開では実行ビットが保たれるとは限らない
            binary.chmod(0o755)
        stamp.write_text(pin['tag'])
    return binary, pin['gpu_layers'].get(key, 0)


def extract_archive(archive, target):
    if str(archive).endswith('.zip'):
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                if member.filename.startswith('/') or '..' in Path(member.filename).parts:
                    raise RuntimeError('运行库压缩包路径异常')
            source.extractall(target)
    else:
        # macOS / Linux の配布物は共有ライブラリの相対リンク（libllama.so -> libllama.so.0 など）を
        # 含む。リンクを一律に拒むと展開できないので、展開先の中で完結するものだけを許す
        with tarfile.open(archive) as source:
            if hasattr(tarfile, 'data_filter'):
                # 'data' フィルタ：絶対パス、展開先の外へ出るパスやリンク、デバイスファイルを拒む
                source.extractall(target, filter='data')
                return
            root = Path(target).resolve()
            for member in source.getmembers():
                destination = (root / member.name).resolve()
                if root != destination and root not in destination.parents:
                    raise RuntimeError('运行库压缩包路径异常')
                if member.issym():
                    link = (destination.parent / member.linkname).resolve()
                    if root not in link.parents:
                        raise RuntimeError('运行库压缩包的链接指向目录之外，拒收')
                elif member.islnk() or member.isdev():
                    raise RuntimeError('运行库压缩包含硬链接或设备文件，拒收')
            source.extractall(target)


