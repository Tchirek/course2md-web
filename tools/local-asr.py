"""Local OpenAI-style transcription endpoint, started by fast-asr-server.mjs."""

import io
import json
import os
import shutil
import sys
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from pins import PINS, VerifiedFiles
from service_lifecycle import IdleWatch, idle_message, memory_hint


def state(name, message=""):
    print(json.dumps({"state": name, "message": message}), flush=True)


def data_dir():
    """The helper passes its data directory (tools/helper-data.mjs); the defaults are for running this by hand."""
    if os.environ.get("C2MD_DATA_DIR"):
        return Path(os.environ["C2MD_DATA_DIR"])
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "course2md"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "course2md"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "course2md"


def nvidia_root():
    """site-packages/nvidia of this environment, where NVIDIA's cuBLAS / cuDNN wheels unpack."""
    import site
    for base in site.getsitepackages():
        root = Path(base) / "nvidia"
        if (root / "cublas").is_dir() and (root / "cudnn").is_dir():
            return root
    return None


def loaded_path(name):
    """Windows: the file a DLL name is actually mapped from in this process (None if not loaded)."""
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetModuleHandleW.restype = wintypes.HMODULE
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetModuleFileNameW.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    handle = kernel32.GetModuleHandleW(name)
    if not handle:
        return None
    buffer = ctypes.create_unicode_buffer(1024)
    kernel32.GetModuleFileNameW(handle, buffer, 1024)
    return Path(buffer.value)


def load_cuda_libraries():
    """Loads the pinned cuBLAS and cuDNN (runtime-pins.json → cuda-runtime) before CTranslate2 does.

    CTranslate2 links cuBLAS / cuDNN by name. Whatever copy is already mapped under that name is the one
    it uses, so these are loaded first, by full path, and then checked. Returns the cuBLAS version.
    """
    import ctypes
    root = nvidia_root()
    if root is None:
        raise RuntimeError("没有安装显卡加速库")
    if sys.platform == "win32":
        folders = [root / "cublas" / "bin", root / "cudnn" / "bin"]
        for folder in folders:
            os.add_dll_directory(str(folder))
        # cuDNN loads its sub-libraries by name at run time with the ordinary search order, which uses PATH
        os.environ["PATH"] = os.pathsep.join(str(folder) for folder in folders) + os.pathsep + os.environ.get("PATH", "")
        cudnn = sorted((root / "cudnn" / "bin").glob("cudnn*64_9.dll"), key=lambda p: (p.name != "cudnn64_9.dll", p.name))
        for path in [root / "cublas" / "bin" / "cublasLt64_12.dll", root / "cublas" / "bin" / "cublas64_12.dll", *cudnn]:
            ctypes.WinDLL(str(path))
        for name in ("cublasLt64_12.dll", "cublas64_12.dll", "cudnn64_9.dll", "cudnn_ops64_9.dll", "cudnn_cnn64_9.dll"):
            actual = loaded_path(name)
            if actual is None or root not in actual.parents:
                raise RuntimeError(f"{name} 没有从固定版本加载（实际：{actual}）")
        cublas = ctypes.WinDLL(str(root / "cublas" / "bin" / "cublas64_12.dll"))
    else:
        cudnn = sorted((root / "cudnn" / "lib").glob("libcudnn*.so.9"), key=lambda p: (p.name != "libcudnn.so.9", p.name))
        for path in [root / "cublas" / "lib" / "libcublasLt.so.12", root / "cublas" / "lib" / "libcublas.so.12", *cudnn]:
            ctypes.CDLL(str(path), mode=ctypes.RTLD_GLOBAL)
        cublas = ctypes.CDLL(str(root / "cublas" / "lib" / "libcublas.so.12"), mode=ctypes.RTLD_GLOBAL)
    parts = []
    for kind in range(3):  # MAJOR_VERSION, MINOR_VERSION, PATCH_LEVEL
        value = ctypes.c_int()
        cublas.cublasGetProperty(kind, ctypes.byref(value))
        parts.append(str(value.value))
    return ".".join(parts)


def self_test(model):
    """Runs the GPU paths the service uses (beam search, sampling, the cuDNN convolutions) on synthetic audio."""
    import numpy as np
    audio = (np.random.default_rng(7).standard_normal(16000 * 4) * 0.05).astype(np.float32)
    for options in (dict(beam_size=5), dict(beam_size=1, best_of=5, temperature=0.8)):
        segments, _ = model.transcribe(audio, language="en", vad_filter=False, condition_on_previous_text=False, **options)
        list(segments)


try:
    # The pinned CUDA libraries go in before anything imports CTranslate2 (faster_whisper does, at import):
    # whichever copy of a DLL is mapped first is the one CTranslate2 links to
    cuda_error = None
    if os.environ.get("C2MD_ASR_DEVICE") != "cpu":
        try:
            load_cuda_libraries()
        except Exception as error:
            cuda_error = error
    from faster_whisper.utils import download_model

    cache = data_dir() / "models"
    legacy = Path.home() / ".cache" / "course2md" / "models"
    if sys.platform != "win32" and legacy.is_dir() and not cache.exists():
        # older versions kept the model under ~/.cache on macOS / Linux
        cache.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(legacy), str(cache))
    cache.mkdir(parents=True, exist_ok=True)
    # 模型取固定提交，逐个文件核对 SHA-256 后才加载（见 runtime-pins.json）
    pin = PINS["whisper-small"]
    verified = VerifiedFiles(cache / "verified.json")

    def pinned_model(local_only):
        return download_model(pin["repo"], cache_dir=str(cache), local_files_only=local_only, revision=pin["revision"])

    def intact(path):
        return all(verified.matches(Path(path) / name, digest) for name, digest in pin["sha256"].items())

    try:
        model_path = pinned_model(True)
    except Exception:
        state("downloading", "本机没有 small 多语言模型，正在下载")
        model_path = pinned_model(False)
    if not intact(model_path):
        # 缓存与固定版本的哈希不符（损坏或被改动）：清掉这份缓存，重新下载一次
        state("downloading", "本机模型文件校验不通过，正在重新下载")
        shutil.rmtree(cache / ("models--" + pin["repo"].replace("/", "--")), ignore_errors=True)
        model_path = pinned_model(False)
        if not intact(model_path):
            raise RuntimeError("small 模型文件与固定版本的 SHA-256 不符，已停止加载")
    state("loading", "正在加载 small 多语言模型")
    device = "cpu"
    # Why the GPU is not used, when it is not (shown in the panel's status line)
    note = ""
    if os.environ.get("C2MD_ASR_DEVICE") == "cpu":
        note = "显卡转录出错后改用 CPU"
    else:
        try:
            if cuda_error is not None:
                raise cuda_error
            from faster_whisper import WhisperModel
            model = WhisperModel(model_path, device="cuda", compute_type="float16")
            self_test(model)
            device = "cuda"
        except Exception as error:
            note = f"显卡不可用，改用 CPU（{type(error).__name__}: {str(error)[:160]}）" if nvidia_root() else ""
    if device == "cpu":
        from faster_whisper import WhisperModel
        model = WhisperModel(model_path, device="cpu", compute_type="int8")
except Exception as error:
    LOAD_ERROR = error
else:
    LOAD_ERROR = None


# CUDA のエラーは「張り付く」：一度起きるとこのプロセスの CUDA コンテキストは以後の推論で
# 失敗し続ける（実例：仮想メモリ枯渇で最初の切片が失敗した後、すべての切片が
# cudaErrorInvalidResourceHandle になった）。こうした失敗では応答を返してから自ら終了し、
# 助手に新しいプロセスで起動し直させる。入力音声の不備などはプロセスを残す。
FATAL_WORDS = ("cuda", "cudnn", "cublas", "out of memory")


MEMORY_WORDS = ("failed to allocate", "out of memory", "bad_alloc", "cannot allocate")


def describe(error):
    """空にならないエラー文。MemoryError などは str() が空なので型名で補う。"""
    text = str(error).strip()
    # MKL / CUDA report exhausted memory in their own words; all get the same actionable message
    if isinstance(error, MemoryError) or any(word in text.lower() for word in MEMORY_WORDS):
        return f"内存不足（{memory_hint()}）" + (f"：{text}" if text else "")
    return f"{type(error).__name__}: {text}" if text else type(error).__name__


def poisons_process(error):
    if isinstance(error, MemoryError):
        return True
    return device == "cuda" and any(word in str(error).lower() for word in FATAL_WORDS)


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "model": "small", "device": device, "note": note})
        elif self.path == "/v1/models":
            self.send_json(200, {"data": [{"id": "small"}]})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        with WATCH:
            self.transcribe()

    def transcribe(self):
        if self.path != "/v1/audio/transcriptions":
            return self.send_json(404, {"error": "not found"})
        origin = self.headers.get("Origin", "")
        if origin and not origin.startswith("chrome-extension://"):
            return self.send_json(403, {"error": "仅接受扩展请求"})
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 32 * 1024 * 1024:
            return self.send_json(413, {"error": "音频切片过大"})
        try:
            header = f'Content-Type: {self.headers.get("Content-Type", "")}\r\n\r\n'.encode()
            message = BytesParser(policy=default).parsebytes(header + self.rfile.read(length))
            fields = {part.get_param("name", header="content-disposition"): part for part in message.iter_parts()}
            audio = fields["file"].get_payload(decode=True)
            language = fields.get("language")
            language = language.get_payload(decode=True).decode("utf-8").strip() if language else None
            language = language.split("-")[0].split("_")[0].lower() if language else None
            prompt = fields.get("prompt")
            prompt = prompt.get_payload(decode=True).decode("utf-8").strip()[:200] if prompt else None
            options = dict(beam_size=3, temperature=(0, .2, .4, .6),
                           condition_on_previous_text=False, language=language or None,
                           vad_filter=True, initial_prompt=prompt,
                           vad_parameters={"min_silence_duration_ms": 500})
            segments, _ = model.transcribe(io.BytesIO(audio), **options)
            items = [{"start": item.start, "end": item.end, "text": item.text} for item in segments]
            if sum(item["text"].count("\ufffd") for item in items) >= 3:
                options.update(beam_size=5, temperature=(.4, .6, .8, 1.0), initial_prompt=None)
                segments, _ = model.transcribe(io.BytesIO(audio), **options)
                items = [{"start": item.start, "end": item.end, "text": item.text} for item in segments]
            if sum(item["text"].count("\ufffd") for item in items) >= 3:
                return self.send_json(500, {"error": "本机模型连续产出乱码，已停止；请重试或改用平台字幕"})
            self.send_json(200, {"text": "".join(item["text"] for item in items).strip(), "segments": items})
        except Exception as error:
            if poisons_process(error):
                message = describe(error)
                self.send_json(503, {"error": message, "restart": True})
                self.wfile.flush()
                state("error", message)
                os._exit(75)
            self.send_json(400, {"error": describe(error)})

    def log_message(self, *_args):
        pass


if LOAD_ERROR is not None:
    state("error", describe(LOAD_ERROR))
    sys.exit(1)

try:
    server = HTTPServer(("127.0.0.1", int(os.environ.get("C2MD_ASR_PORT", "8080"))), Handler)
    WATCH = IdleWatch(server.shutdown)
    print(json.dumps({"state": "ready", "device": device, "note": note,
                      "message": f"本机转录服务已启动（{'显卡' if device == 'cuda' else 'CPU'}）"}), flush=True)
    server.serve_forever()
    state("idle", idle_message("本机转录模型"))
except Exception as error:
    state("error", str(error))
    sys.exit(1)
