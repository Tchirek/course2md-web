"""Local OpenAI-style transcription endpoint, started by fast-asr-server.mjs."""

import io
import json
import os
import sys
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def state(name, message=""):
    print(json.dumps({"state": name, "message": message}), flush=True)


try:
    from faster_whisper import WhisperModel
    from faster_whisper.utils import download_model

    cache = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".cache") / "course2md" / "models"
    cache.mkdir(parents=True, exist_ok=True)
    try:
        model_path = download_model("small", cache_dir=str(cache), local_files_only=True)
    except Exception:
        state("downloading", "本机没有 small 多语言模型，正在下载")
        model_path = download_model("small", cache_dir=str(cache))
    state("loading", "正在加载 small 多语言模型")
    device = "cpu"
    try:
        if sys.platform == "win32":
            try:
                import torch  # 让 CUDA/cuDNN DLL 对 CTranslate2 可见
            except ImportError:
                pass
        model = WhisperModel(model_path, device="cuda", compute_type="float16")
        device = "cuda"
    except Exception:
        model = WhisperModel(model_path, device="cpu", compute_type="int8")
except Exception as error:
    state("error", str(error))
    sys.exit(1)


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
            self.send_json(200, {"ok": True, "model": "small", "device": device})
        elif self.path == "/v1/models":
            self.send_json(200, {"data": [{"id": "small"}]})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
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
            self.send_json(400, {"error": str(error)})

    def log_message(self, *_args):
        pass


try:
    server = HTTPServer(("127.0.0.1", int(os.environ.get("C2MD_ASR_PORT", "8080"))), Handler)
    state("ready", f"本机转录服务已启动（{'显卡' if device == 'cuda' else 'CPU'}）")
    server.serve_forever()
except Exception as error:
    state("error", str(error))
    sys.exit(1)
