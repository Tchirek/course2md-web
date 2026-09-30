"""Qwen3-ASR adapter: stdlib Python, upstream model layout, existing helper protocol."""
import array
import base64
import io
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request
import wave
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

if sys.version_info < (3, 11):
    # tomllib, which reads the original's config.toml, arrived in 3.11
    print(json.dumps({'state': 'error', 'message': f'本机转录需要 Python 3.11 或更新版本（当前 {sys.version.split()[0]}），'
                      '可用环境变量 C2MD_PYTHON 指定'}, ensure_ascii=False), flush=True)
    sys.exit(1)
import tomllib  # noqa: E402

from pins import PINS, VerifiedFiles
from runtime_download import file_lock, pinned_download, prepare_llama, state
from service_lifecycle import IdleWatch, idle_message, memory_hint, popen_bound


def config_path():
    base = os.environ.get('XDG_CONFIG_HOME') or (os.environ.get('APPDATA') if sys.platform == 'win32' else None)
    return (Path(base) if base else Path.home() / '.config') / 'course2md' / 'config.toml'


def model_dir():
    if os.environ.get('C2MD_MODEL_DIR'):
        return Path(os.environ['C2MD_MODEL_DIR']).expanduser().resolve()
    config = config_path()
    settings = tomllib.loads(config.read_text(encoding='utf-8')) if config.exists() else {}
    chosen = settings.get('defaults', {}).get('model_dir')
    if chosen is not None:
        if not isinstance(chosen, str) or not chosen.strip():
            raise ValueError(f'{config} 的 defaults.model_dir 必须是非空路径')
        result = Path(chosen).expanduser()
        if not result.is_absolute():
            raise ValueError(f'{config} 的 defaults.model_dir 请使用绝对路径，避免两个程序的工作目录不同')
        return result
    return default_model_dir()


def default_model_dir():
    """The original's own default (config.rs cache_dir()/models), used when its config.toml names none."""
    base = os.environ.get('XDG_CACHE_HOME') or (os.environ.get('LOCALAPPDATA') if sys.platform == 'win32' else None)
    return (Path(base) if base else Path.home() / '.cache') / 'course2md' / 'models'


def has_model(root):
    """Both GGUF files are in the original's layout (not checking contents: prepare_model does that)."""
    return all((root / 'llama-qwen3-1.7b' / name).is_file() for name in PINS['qwen-asr']['sha256'])


def configure_models(target):
    """An explicit --data-dir also gives future upstream installs the same cache; preserve an existing choice."""
    config = config_path()
    with file_lock(config.parent / '.web-models.lock'):
        text = config.read_text(encoding='utf-8') if config.exists() else ''
        value = tomllib.loads(text)
        if value.get('defaults', {}).get('model_dir') is not None:
            return model_dir()
        # The original already downloaded the model to its default place: share that copy instead
        if has_model(default_model_dir()) and not has_model(Path(target)):
            return default_model_dir()
        line = 'model_dir = ' + json.dumps(str(Path(target).resolve()), ensure_ascii=False) + '\n'
        match = re.search(r'^\[defaults\][ \t]*(?:#[^\n]*)?\r?$', text, re.M)
        if match:
            text = text[:match.end()] + '\n' + line + text[match.end():]
        elif 'defaults' in value:
            raise ValueError('请在原版 config.toml 的 defaults 中设置 model_dir 后重试（保留了原配置）')
        else:
            text = text.rstrip() + '\n\n[defaults]\n' + line
        tomllib.loads(text)
        pending = config.with_suffix('.toml.web-tmp')
        pending.write_text(text, encoding='utf-8')
        pending.replace(config)
    return model_dir()


def prepare_model():
    root = model_dir()
    pin = PINS['qwen-asr']
    # The same OS lock and layout as course2md/src/models.rs.
    with file_lock(root / '.download.lock'):
        verified = VerifiedFiles(root / '.web-verified.json')
        folder = root / 'llama-qwen3-1.7b'
        endpoint = os.environ.get('HF_ENDPOINT', 'https://huggingface.co').rstrip('/')
        if not endpoint.startswith('https://'):
            raise ValueError('HF_ENDPOINT 必须使用 HTTPS')
        for name, digest in pin['sha256'].items():
            pinned_download(f'{endpoint}/{pin["repo"]}/resolve/{pin["revision"]}/{name}',
                            folder / name, digest, f'正在下载共享 Qwen3-ASR：{name}', verified, preserve=True)
    return folder


# The same GPU backends the original counts (asr.rs is_gpu_device_id); BLAS / CPU rows do not count.
GPU_DEVICE = re.compile(r'^\s*(?:MTL|CUDA|Vulkan|SYCL|ROCm)\d*:\s*\S', re.M)
NO_WINDOW = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}


def gpu_available(binary):
    """Whether this llama-server sees a GPU. A positive -ngl is only a request: the Windows CUDA build
    runs on the CPU when there is no NVIDIA GPU, and the status line would wrongly say 显卡."""
    try:
        result = subprocess.run([str(binary), '--list-devices'], capture_output=True, text=True,
                                encoding='utf-8', errors='replace', timeout=30, **NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return False
    rows = (result.stdout + result.stderr).partition('Available devices:')[2]
    return result.returncode == 0 and bool(GPU_DEVICE.search(rows))


RATE = 16000
WINDOW = 20 * RATE
# One request may run to 21 s: the helper's 20-second pieces carry 0.25 s of silence on each end
SLACK = RATE
HOP = RATE // 10


def windows(samples):
    """Cuts audio longer than one window at the quietest 100 ms within the last 3 s before each
    20-second limit (course2md asr.rs split_smart), instead of in the middle of a word."""
    total = len(samples)
    if total <= WINDOW + SLACK:
        return [(0, total)]
    cuts = []
    start = 0
    while total - start > WINDOW + SLACK:
        target = start + WINDOW
        best, best_energy = target, None
        # 100 ms steps on a grid from the start of the audio, as the original measures its energy
        first = -(-(target - 3 * RATE) // HOP) * HOP
        for hop in range(first, target - HOP + 1, HOP):
            energy = sum(v * v for v in samples[hop:hop + HOP])
            if best_energy is None or energy < best_energy:
                best, best_energy = hop + HOP // 2, energy
        cuts.append((start, best))
        start = best
    cuts.append((start, total))
    return cuts


def sanitize(text):
    text = text.split('</asr_text>', 1)[0].rsplit('<asr_text>', 1)[-1].strip()
    return re.sub(r'^language\s+\S+\s+', '', text, flags=re.I).strip()


def start_model(folder, binary, gpu_layers, work):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    log_path = work / 'qwen-asr.log'
    # A local bearer secret also keeps unrelated processes from using the internal model endpoint.
    import secrets
    key = secrets.token_hex(32)
    args = [str(binary), '-m', str(folder / 'Qwen3-ASR-1.7B-Q8_0.gguf'),
            '--mmproj', str(folder / 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'),
            '--alias', 'course2md-web-asr', '--host', '127.0.0.1', '--port', str(port),
            '--api-key', key, '-ngl', str(gpu_layers), '-c', '4096', '-n', '1024', '--parallel', '1']
    if not gpu_layers:
        args += ['--device', 'none', '--no-mmproj-offload', '--no-op-offload']
    with open(log_path, 'w', encoding='utf-8') as log:
        process = popen_bound(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                              **NO_WINDOW)
    try:
        for _ in range(180):
            if process.poll() is not None:
                detail = log_path.read_text(encoding='utf-8', errors='replace')[-1600:]
                if re.search(r'out of memory|alloc|mem_buffer != NULL', detail, re.I):
                    raise RuntimeError(f'模型加载时内存不足（{memory_hint()}）')
                raise RuntimeError(detail[-500:])
            try:
                with urllib.request.urlopen(base + '/health', timeout=1) as response:
                    if response.status == 200:
                        return process, base, key
            except OSError:
                time.sleep(1)
        raise RuntimeError('Qwen3-ASR 加载超时')
    except BaseException:
        if process.poll() is None:
            process.kill()
        process.wait()
        raise


def transcribe(audio, base, key):
    try:
        with wave.open(io.BytesIO(audio)) as probe:
            normalized = (probe.getnchannels(), probe.getsampwidth(), probe.getframerate()) == (1, 2, 16000)
    except (wave.Error, EOFError):
        normalized = False
    if not normalized:
        # Browser recording fallback sends WebM/Opus (or MP4), not PCM WAV.
        result = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
                                 '-t', '121', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
                                input=audio, capture_output=True, timeout=60,
                                **NO_WINDOW)
        if result.returncode:
            raise ValueError('无法解码录音：' + result.stderr.decode(errors='replace')[-200:])
        if len(result.stdout) > 120 * 16000 * 2:
            raise ValueError('音频切片不能超过 120 秒')
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as output:
            output.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            output.writeframes(result.stdout)
        audio = buffer.getvalue()
    # Bound each request to 20 s so speech cannot silently exceed the generation/context limit.
    with wave.open(io.BytesIO(audio)) as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
            raise ValueError('内置转录需要 16kHz 单声道 PCM WAV')
        count = wav.getnframes()
        if count > 120 * 16000:
            raise ValueError('音频切片不能超过 120 秒')
        audio_samples = array.array('h', wav.readframes(count))
        if sys.byteorder != 'little':
            audio_samples.byteswap()
        segments = []
        for offset, stop in windows(audio_samples):
            samples = audio_samples[offset:stop]
            # Silence must not generate invented captions.
            if not samples or max(abs(v) for v in samples) < 32:
                continue
            frames = samples.tobytes() if sys.byteorder == 'little' else _swapped(samples)
            buf = io.BytesIO()
            with wave.open(buf, 'wb') as part:
                part.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                part.writeframes(frames)
            body = json.dumps({'temperature': 0, 'max_tokens': 1024, 'messages': [{'role': 'user', 'content': [
                {'type': 'text', 'text': 'Transcribe the audio.'},
                {'type': 'input_audio', 'input_audio': {'data': base64.b64encode(buf.getvalue()).decode(), 'format': 'wav'}},
            ]}]}).encode()
            req = urllib.request.Request(base + '/v1/chat/completions', body,
                                         {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'})
            with urllib.request.urlopen(req, timeout=180) as response:
                choice = json.load(response)['choices'][0]
            if choice.get('finish_reason') == 'length':
                raise RuntimeError('转录输出超出长度限制，已停止以免丢字')
            content = choice['message']['content']
            if not isinstance(content, str):
                raise ValueError('转录模型没有返回文本')
            text = sanitize(content)
            if text:
                segments.append({'start': offset / RATE, 'end': stop / RATE, 'text': text})
    return {'text': ' '.join(item['text'] for item in segments), 'segments': segments}


def _swapped(samples):
    copy = array.array('h', samples)
    copy.byteswap()
    return copy.tobytes()


def serve():
    work = Path(os.environ['C2MD_DATA_DIR']) / 'asr'
    work.mkdir(parents=True, exist_ok=True)
    folder = prepare_model()
    binary, layers = prepare_llama()
    if os.environ.get('C2MD_ASR_DEVICE') == 'cpu' or (layers and not gpu_available(binary)):
        layers = 0
    state('loading', '正在加载共享 Qwen3-ASR 模型')
    # The helper asks for the CPU only after a GPU failure in the middle of a job
    note = '显卡转录出错后改用 CPU' if os.environ.get('C2MD_ASR_DEVICE') == 'cpu' else ''
    try:
        process, base, key = start_model(folder, binary, layers, work)
    except Exception as error:
        if not layers:
            raise
        note = f'显卡不可用，改用 CPU：{str(error)[-160:]}'
        layers = 0
        state('loading', note)
        process, base, key = start_model(folder, binary, layers, work)
    health = {'ok': True, 'model': 'Qwen3-ASR-1.7B', 'device': 'cuda' if layers else 'cpu', 'note': note}

    class Handler(BaseHTTPRequestHandler):
        def send_json(self, code, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == '/health':
                self.send_json(200 if process.poll() is None else 503, health)
            elif self.path == '/v1/models':
                self.send_json(200, {'data': [{'id': health['model']}]})
            else:
                self.send_json(404, {'error': 'not found'})

        def do_POST(self):
            if self.path != '/v1/audio/transcriptions':
                return self.send_json(404, {'error': 'not found'})
            origin = self.headers.get('Origin', '')
            if origin and not origin.startswith('chrome-extension://'):
                return self.send_json(403, {'error': '仅接受扩展请求'})
            with watch:
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= 32 * 1024 * 1024:
                        return self.send_json(413, {'error': '音频切片过大'})
                    header = f'Content-Type: {self.headers.get("Content-Type", "")}\r\n\r\n'.encode()
                    fields = BytesParser(policy=default).parsebytes(header + self.rfile.read(length))
                    audio = next(p.get_payload(decode=True) for p in fields.iter_parts()
                                 if p.get_param('name', header='content-disposition') == 'file')
                    self.send_json(200, transcribe(audio, base, key))
                except Exception as error:
                    self.send_json(503, {'error': str(error) or type(error).__name__})

        def log_message(self, *_args):
            pass

    try:
        with HTTPServer(('127.0.0.1', int(os.environ.get('C2MD_ASR_PORT', '8081'))), Handler) as server:
            watch = IdleWatch(server.shutdown)
            print(json.dumps({'state': 'ready', **health, 'message': '共享 Qwen3-ASR 已就绪'}), flush=True)
            server.serve_forever()
            state('idle', idle_message('本机转录模型'))
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)


if __name__ == '__main__':
    try:
        if '--configure-models' in sys.argv:
            print(configure_models(sys.argv[sys.argv.index('--configure-models') + 1]))
        elif '--model-dir' in sys.argv:
            print(model_dir())
        else:
            serve()
    except Exception as error:
        state('error', str(error) or type(error).__name__)
        sys.exit(1)
