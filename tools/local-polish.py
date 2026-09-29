"""Local punctuation first, Qwen3.5-2B for hard sentences, OpenAI-style stream."""
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pins import PINS, VerifiedFiles
from service_lifecycle import IdleWatch, idle_message, popen_bound

ROOT = Path(os.environ['C2MD_POLISH_HOME'])
ROOT.mkdir(parents=True, exist_ok=True)
# ダウンロードするものはすべて runtime-pins.json の版と SHA-256 に固定し、確かめてから使う
VERIFIED = VerifiedFiles(ROOT / 'verified.json')
# Xet 下载后端在大文件上内存波动大，低内存机器会直接崩；走普通 HTTP 分块下载。
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_ENABLE_HF_TRANSFER', '0')


def state(name, message):
    print(json.dumps({'state': name, 'message': message}), flush=True)


def prepare_punc():
    source = PINS['fireredpunc-source']
    package = ROOT / 'fireredasr2s' / 'fireredpunc'
    if not all(VERIFIED.matches(package / name, digest) for name, digest in source['sha256'].items()):
        state('downloading', '正在取得 FireRedPunc 程序')
        archive = ROOT / 'firered.tar.gz'
        # ブランチではなく固定したコミットの tarball。清単にあるファイルだけを、ハッシュを確かめてから書き出す
        urllib.request.urlretrieve(f'https://github.com/{source["repo"]}/archive/{source["commit"]}.tar.gz', archive)
        marker = f'/{source["path"]}/'
        with tarfile.open(archive) as tar:
            for member in tar:
                if marker not in member.name or not member.isfile():
                    continue
                relative = member.name.split(marker, 1)[1]
                if relative not in source['sha256']:
                    continue
                data = tar.extractfile(member).read()
                if hashlib.sha256(data).hexdigest() != source['sha256'][relative]:
                    raise RuntimeError(f'FireRedPunc 程序文件 {relative} 与固定版本不符，已拒收')
                target = package / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        archive.unlink()
        missing = [name for name, digest in source['sha256'].items() if not VERIFIED.matches(package / name, digest)]
        if missing:
            raise RuntimeError(f'FireRedPunc 程序缺少文件：{"、".join(missing)}')
    (ROOT / 'fireredasr2s' / '__init__.py').touch()
    sys.path.insert(0, str(ROOT))
    from fireredasr2s.fireredpunc.punc import FireRedPunc, FireRedPuncConfig
    # 固定したリビジョンから必要なファイルだけを取る（tf_model.h5 は TensorFlow の重みで使わない）。
    # huggingface_hub のダウンローダーは本機で繰り返し落ちたので使わない
    model = PINS['fireredpunc-model']
    model_dir = ROOT / 'FireRedPunc'
    for name, digest in model['sha256'].items():
        pinned_download(f'https://huggingface.co/{model["repo"]}/resolve/{model["revision"]}/{name}',
                        model_dir / name, digest, f'正在下载 {name}')
    state('loading', '正在加载 FireRedPunc')
    return FireRedPunc.from_pretrained(str(model_dir), FireRedPuncConfig(use_gpu=False))


def robust_download(url, target, message):
    """纯 urllib 断点续传下载；hf_hub 的下载后端在本机反复崩溃，不再依赖它。"""
    part = target.with_suffix(target.suffix + '.part')
    request = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(request, timeout=30) as response:
        total = int(response.headers.get('Content-Length') or 0)
    if target.exists() and total and target.stat().st_size == total:
        return target
    while not (total and part.exists() and part.stat().st_size >= total):
        done = part.stat().st_size if part.exists() else 0
        headers = {'Range': f'bytes={done}-'} if done else {}
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response, open(part, 'ab' if done else 'wb') as sink:
                while True:
                    block = response.read(1 << 20)
                    if not block:
                        break
                    sink.write(block)
        except Exception:
            time.sleep(2)
    if total and part.stat().st_size != total:
        raise RuntimeError(f'下载不完整：{part.stat().st_size}/{total}')
    part.replace(target)
    return target


def pinned_download(url, target, digest, message):
    """固定版のファイルを取り、SHA-256 を確かめる。合わなければ消して止め、未検証のものは残さない。"""
    if VERIFIED.matches(target, digest):
        return target
    state('downloading', message)
    target.parent.mkdir(parents=True, exist_ok=True)
    # 大きさが同じで中身の違う古いファイルを「取得済み」と見なさないよう、先に消す
    target.unlink(missing_ok=True)
    robust_download(url, target, message)
    if not VERIFIED.matches(target, digest):
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
    pin = PINS['llama.cpp']
    key = llama_platform()
    assets = pin['assets'].get(key)
    if not assets:
        raise RuntimeError(f'没有适用于 {key} 的 llama.cpp 运行库')
    binary_name = 'llama-server.exe' if sys.platform == 'win32' else 'llama-server'
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
                            archive, asset['sha256'], '正在准备 Qwen3.5-2B 运行库')
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


def start_qwen():
    qwen = PINS['qwen']
    model = pinned_download(f'https://huggingface.co/{qwen["repo"]}/resolve/{qwen["revision"]}/{qwen["file"]}',
                            ROOT / 'qwen' / qwen['file'], qwen['sha256'], '正在下载 Qwen3.5-2B')
    binary, gpu_layers = prepare_llama()
    state('loading', '正在加载 Qwen3.5-2B')
    # llama-server は数 GB を抱えるので、このプロセスが強制終了されても道連れにする
    process = popen_bound([str(binary), '-m', str(model), '--alias', 'Qwen/Qwen3.5-2B',
                     '--host', '127.0.0.1', '--port', '8083', '-ngl', str(gpu_layers), '-c', '4096', '--parallel', '1'])
    for _ in range(120):
        if process.poll() is not None:
            raise RuntimeError('Qwen3.5-2B 服务启动失败')
        try:
            with urllib.request.urlopen('http://127.0.0.1:8083/health', timeout=1) as response:
                if response.status == 200:
                    return process
        except Exception:
            time.sleep(1)
    raise RuntimeError('Qwen3.5-2B 加载超时')


def qwen_polish(original, punctuated, instruction, context):
    # 外层的逐条 JSON 契约只约束 HTTP 回复；内部单句校对要输出纯文本。
    instruction = instruction.split('输出与输入逐条对应的 JSON 对象', 1)[0].strip()
    body = json.dumps({
        'model': 'Qwen/Qwen3.5-2B', 'temperature': 0,
        'chat_template_kwargs': {'enable_thinking': False},
        'messages': [
            {'role': 'system', 'content': instruction + '\n校正有把握的同音错字与术语；拿不准的专名保留原字。只输出校对后的纯文本，不解释，不增删观点或事实。'},
            {'role': 'user', 'content': f'参考信息（不要输出）：{context}\n\n仅校对这句：{original}\n标点参考：{punctuated}'},
        ], 'max_tokens': 512,
    }, ensure_ascii=False).encode()
    request = urllib.request.Request('http://127.0.0.1:8083/v1/chat/completions', body,
                                     {'content-type': 'application/json'})
    with urllib.request.urlopen(request, timeout=120) as response:
        choice = json.load(response)['choices'][0]
        return choice['message']['content'].strip() if choice['finish_reason'] != 'length' else ''


def payload_from(messages):
    user = next((message['content'] for message in reversed(messages) if message['role'] == 'user'), '')
    start = user.rfind('{"segments":')
    if start < 0:
        raise ValueError('未收到逐段文本')
    return json.JSONDecoder().raw_decode(user[start:])[0]['segments']


def tidy_punctuation(text):
    text = re.sub(r'[，,]\s*([。！？!?])', r'\1', text)
    text = re.sub(r'([，。！？、；：,.!?;:])(?:\s*\1)+', r'\1', text)
    return re.sub(r'\s+([，。！？、；：])', r'\1', text).strip()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'ok': True, 'model': 'FireRedPunc + Qwen3.5-2B'}).encode()
        self.send_response(200 if self.path == '/health' else 404)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        with WATCH:
            self.polish()

    def polish(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        if self.headers.get('Origin', '').startswith('http'):
            self.send_error(403)
            return
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0 or length > 1024 * 1024:
            self.send_error(413)
            return
        streaming = False
        try:
            request = json.loads(self.rfile.read(length))
            items = payload_from(request['messages'])
            if not items:
                raise ValueError('文本为空')
            instruction = request['messages'][0]['content']
            context = request['messages'][-1]['content'].split('待校对：', 1)[0].strip()[-600:]
            light = '只修正标点' in instruction
            with PUNC_LOCK:
                punctuated = PUNC.process([re.sub(r'[，。！？、；：!?;]|(?<!\d)[.,]|[.,](?!\d)', '', item['text']) for item in items])
            output = []
            if request.get('stream'):
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream; charset=utf-8')
                self.end_headers()
                streaming = True
            for item, punc in zip(items, punctuated):
                original = item['text']
                text = tidy_punctuation(punc['punc_text'])
                if not light:
                    try:
                        candidate = tidy_punctuation(qwen_polish(original, text, instruction, context))
                    except Exception:
                        candidate = ''
                    if candidate and not re.search(r'^(?:前文|原文|标点参考)[:：]|^\{', candidate) and len(original) * .65 <= len(candidate) <= len(original) * 1.5:
                        text = candidate
                output.append({'id': item['id'], 'text': text})
                if request.get('stream'):
                    prefix = '{"segments":[' if len(output) == 1 else ','
                    delta = prefix + json.dumps(output[-1], ensure_ascii=False, separators=(',', ':'))
                    event = {'choices': [{'delta': {'content': delta}}]}
                    self.wfile.write(f'data: {json.dumps(event, ensure_ascii=False)}\n\n'.encode())
                    self.wfile.flush()
            content = '{"segments":[' + ','.join(json.dumps(item, ensure_ascii=False, separators=(',', ':')) for item in output) + ']}'
            if request.get('stream'):
                event = {'choices': [{'delta': {'content': ']}'}}]}
                self.wfile.write(f'data: {json.dumps(event, ensure_ascii=False)}\n\n'.encode())
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                data = json.dumps({'choices': [{'message': {'content': content}}]}, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except Exception as error:
            if not self.wfile.closed:
                try:
                    data = json.dumps({'error': {'message': str(error)}}, ensure_ascii=False).encode()
                    if streaming:
                        self.wfile.write(b'data: ' + data + b'\n\n')
                    else:
                        self.send_response(500)
                        self.send_header('content-type', 'application/json')
                        self.end_headers()
                        self.wfile.write(data)
                except Exception:
                    pass

    def log_message(self, *_args):
        pass


try:
    PUNC = prepare_punc()
    PUNC_LOCK = threading.Lock()
    QWEN = start_qwen()
    server = ThreadingHTTPServer(('127.0.0.1', 8082), Handler)
    WATCH = IdleWatch(server.shutdown)
    state('ready', '本机润色已就绪')
    server.serve_forever()
    state('idle', idle_message('本机润色模型'))
except Exception as error:
    state('error', str(error))
    sys.exit(1)
finally:
    if 'QWEN' in globals():
        QWEN.terminate()
        try:
            QWEN.wait(timeout=15)
        except Exception:
            QWEN.kill()
