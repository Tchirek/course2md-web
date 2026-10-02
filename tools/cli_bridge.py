"""Authenticated browser transport for course2md's run-task protocol. Stdlib only."""
import base64
import collections
import concurrent.futures
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import signal
import shutil
import struct
import subprocess
import sys
import threading
import time
import tomllib
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
import desktop_sync


class LoopbackServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer's optional reverse DNS can hang on macOS; loopback needs no lookup.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address


def data_dir():
    if os.environ.get("C2MD_DATA_DIR"):
        return Path(os.environ["C2MD_DATA_DIR"])
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "course2md"
    elif sys.platform == "darwin":
        base = Path.home() / "Library/Application Support/course2md"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "course2md"
    try:
        chosen = Path(json.loads((base / "location.json").read_text())["dir"])
        if chosen.is_absolute():
            return chosen
    except (OSError, ValueError, KeyError):
        pass
    return base


def config_dir():
    return Path(os.environ.get("XDG_CONFIG_HOME", os.environ.get("APPDATA", str(Path.home() / ".config")) if sys.platform == "win32" else str(Path.home() / ".config"))) / "course2md"


def settings():
    file = Path(os.environ.get("C2MD_UPSTREAM_CONFIG", str(config_dir() / "config.toml")))
    return tomllib.loads(file.read_text(encoding="utf-8")) if file.is_file() else {}


def token():
    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    file = folder / "helper-token"
    try:
        with file.open("x", encoding="utf-8") as stream:
            file.chmod(0o600)
            stream.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    value = file.read_text().strip()
    if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("MizoreLink 令牌损坏，请重新连接扩展")
    return value


def engine():
    name = "course2md.exe" if sys.platform == "win32" else "course2md"
    candidates = [os.environ.get("C2MD_UPSTREAM_EXE"), str(data_dir() / "bin" / name), shutil.which("course2md")]
    try:
        candidates.insert(1, json.loads((data_dir() / "upstream-engine.json").read_text())["path"])
    except (OSError, ValueError, KeyError):
        pass
    for folder in ([Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/course2md", Path(os.environ.get("ProgramFiles", "")) / "course2md"] if sys.platform == "win32" else [Path("/Applications/course2md.app/Contents/MacOS"), Path.home() / "bin", Path.home() / ".local/bin"]):
        candidates.append(str(folder / name))
    for candidate in dict.fromkeys(candidates):
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            result = subprocess.run([candidate, "--version"], capture_output=True, text=True, timeout=8, **hidden())
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 and result.stdout.startswith("course2md 2."):
            return str(Path(candidate).resolve())
    raise ValueError("未找到 course2md 2.0 CLI。请先安装 course2md，或设置 C2MD_UPSTREAM_EXE")


def hidden():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def service_status(kind):
    try:
        path = engine()
        cfg = settings()
        llm = cfg.get("llm", {})
        if kind == "polish" and (not llm.get("enabled") or not llm.get("model") or (llm.get("provider") != "codex" and not llm.get("base_url"))):
            raise ValueError("请先在 course2md 配置润色服务，也可在此页选择自定义接口")
        defaults = cfg.get("defaults", {})
        remote = defaults.get("provider") == "api"
        model = llm.get("model", "") if kind == "polish" else (cfg.get("asr_api", {}).get("model", "API 转录") if remote else defaults.get("asr_model") or "Qwen3-ASR-1.7B")
        return {"state": "ready", "message": "CLI 已连接 · " + ("使用已配置的 API 转录" if remote and kind == "asr" else "模型由 course2md 按需准备"), "model": model, "path": path}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {"state": "error", "message": str(error)}


def source_url(value):
    url = urllib.parse.urlsplit(str(value))
    if url.scheme not in ("http", "https", "file"):
        raise ValueError("不支持此视频地址")
    if url.scheme == "file":
        if url.netloc not in ("", "localhost"):
            raise ValueError("不读取远程文件共享")
        return urllib.request.url2pathname(url.path)
    if not url.hostname or url.username or url.password:
        raise ValueError("视频地址无效")
    return str(value)


def events_from(values):
    result = []
    for value in values:
        start, end = float(value["start"]), float(value["end"])
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
            raise ValueError("文字时间无效")
        result.append({"start": start, "end": end, "text": str(value["text"])})
    if not result or not any(item["text"].strip() for item in result):
        raise ValueError("没有可读文字")
    return result


def draft(folder, request, events):
    """A private reprocess input, never published into the user's course library."""
    folder.mkdir()
    meta = {"title": request["title"], "uploader": request["author"], "duration": request["duration"], "webpage_url": request["source"], "extractor": "web", "id": request["source_id"]}
    document = {"schema": 1, "meta": meta, "summary": None, "sections": [{"t": events[0]["start"], "end": max(e["end"] for e in events), "image": "", "speech": events}]}
    body = json.dumps(document, ensure_ascii=False).encode()
    (folder / "document.json").write_bytes(body)
    outcomes = {key: {"status": "not_requested"} for key in ("transcript", "screenshots", "proofreading", "summary")}
    outcomes["transcript"] = {"status": "succeeded"}
    outcomes["exports"] = {}
    manifest = {"schema": 1, "task_id": "input", "course_id": request["course_id"], "source_id": request["source_id"], "version_id": "input", "title": request["title"], "created_at_ms": int(time.time() * 1000), "revision": 1, "document": "document.json", "markdown": "course.md", "frames": [], "assets": [{"path": "document.json", "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}], "outputs": [], "outcomes": outcomes, "partial": False}
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return {"kind": "reprocess", "base_version_dir": str(folder), "components": []}


JOBS = {}
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4)


def start_job(kind, payload):
    source = source_url(payload.get("sourceUrl", "https://course2md.invalid/notes") if kind != "polish" else payload.get("sourceUrl") or "https://course2md.invalid/notes")
    cfg = settings()
    cfg.pop("desktop", None)
    cfg.setdefault("defaults", {}).update({"formats": ["json"], "sample_interval": 1, "cooldown": 10, "slide_mode": "first", "keep_video": False})
    cfg.setdefault("llm", {}).update({"enabled": kind == "polish", "summarize": False, "vision": False})
    if kind == "polish":
        if not cfg["llm"].get("model") or (cfg["llm"].get("provider") != "codex" and not cfg["llm"].get("base_url")):
            raise ValueError("course2md 尚未配置润色模型")
        cfg["llm"].update({"prompt": str(payload.get("instruction", "")), "concurrency": 1})
    else:
        cfg["defaults"]["transcript_source"] = "asr"
    endpoint = str(payload.get("endpoint") or "")
    builtin = endpoint.rstrip("/") in ("cli", "http://127.0.0.1:8081/v1/audio/transcriptions", "http://localhost:8081/v1/audio/transcriptions", "https://127.0.0.1:8081/v1/audio/transcriptions", "https://localhost:8081/v1/audio/transcriptions")
    if kind == "transcribe" and endpoint and not builtin:
        url = urllib.parse.urlsplit(endpoint)
        if url.hostname not in ("localhost", "127.0.0.1", "::1") or url.scheme not in ("http", "https") or not url.path.rstrip("/").endswith("/audio/transcriptions"):
            raise ValueError("ASR 服务必须是本机 OpenAI 兼容转录端点")
        cfg["defaults"]["provider"] = "api"
        cfg["defaults"]["asr_model"] = None
        cfg["asr_api"] = {"base_url": endpoint.rstrip("/")[:-len("/audio/transcriptions")], "api_key": str(payload.get("apiKey", "")), "model": str(payload.get("model", "")), "mode": "transcriptions"}
    if kind == "transcribe":
        cfg["defaults"]["max_speech"] = max(5, min(120, float(payload.get("chunkSeconds", 30))))
    duration = float(payload.get("duration", 0))
    if not math.isfinite(duration) or duration < 0:
        raise ValueError("视频时长无效")
    events = events_from(payload["segments"]) if kind == "polish" else None
    ident = uuid.uuid4().hex
    folder = data_dir() / "bridge-jobs" / ident
    folder.mkdir(parents=True, mode=0o700)
    request = {"schema": 1, "task_id": ident, "course_id": "web-" + hashlib.sha256(source.encode()).hexdigest()[:24], "version_id": ident, "source_id": "web:" + hashlib.sha256(source.encode()).hexdigest(), "source": source, "title": str(payload.get("title") or payload.get("prompt") or "视频笔记"), "author": str(payload.get("uploader", "")), "duration": duration, "config": cfg, "allow_unauthenticated_asr": bool(endpoint and not builtin), "work_dir": str(folder / "work"), "course_dir": str(folder / "course"), "control_path": str(folder / "work/control.json")}
    if kind in ("frames", "polish"):
        events = events or [{"start": 0, "end": max(1, request["duration"]), "text": "截图"}]
        request["operation"] = draft(folder / "input", request, events)
        request["operation"]["components"] = ["proofreading" if kind == "polish" else "screenshots"]
    job = {"state": "running", "message": "正在调用 course2md CLI", "done": 0, "total": 0, "events": [], "images": [], "warnings": [], "kind": kind, "folder": folder, "work": folder / "work", "source": source, "created": time.time(), "cancel": False}
    JOBS[ident] = job
    POOL.submit(run_job, job, request, payload)
    return {"id": ident}


def safe_file(root, relative):
    file = (root / relative).resolve()
    if not file.is_relative_to(root.resolve()) or not file.is_file():
        raise ValueError("CLI 输出文件路径无效")
    return file


def collect(job):
    work = job["work"]
    file = work / "asr.jsonl"
    if file.is_file() and job["state"] == "running":
        values = []
        for line in file.read_text(encoding="utf-8").splitlines():
            try:
                value = json.loads(line)
                if str(value.get("text", "")).strip():
                    values.append(value)
            except ValueError:
                pass  # The writer may not have finished its final line yet.
        # Checkpoint append order is stable even when concurrent ASR chunks finish out of order.
        job["events"] = values


def run_job(job, request, payload):
    try:
        if job["cancel"]:
            raise ValueError("任务已取消")
        if job["kind"] == "frames":
            active = next((other for other in list(JOBS.values()) if other["kind"] == "transcribe" and other["source"] == job["source"] and other["state"] == "running" and other.get("child")), None)
            while active and active["state"] == "running":
                if job["cancel"]:
                    raise ValueError("任务已取消")
                time.sleep(.2)
        # Reuse a completed conversion for screenshots instead of downloading it again.
        cached = next((other for other in reversed(list(JOBS.values())) if job["kind"] == "frames" and not Path(job["source"]).is_file() and other is not job and other["source"] == job["source"] and other["kind"] in ("frames", "transcribe") and other["state"] == "done" and other.get("out") and other["out"].is_dir()), None)
        if cached:
            out = cached["out"]
        else:
            env = dict(os.environ)
            env["PATH"] = os.pathsep.join([str(data_dir() / "bin"), env.get("PATH", "")])
            if payload.get("cookieFile") and urllib.parse.urlsplit(job["source"]).hostname in ("www.bilibili.com", "bilibili.com"):
                # The CLI receives a private browser-session snapshot; desktop auth is untouched.
                profile = job["folder"] / "profile/course2md/auth"
                profile.mkdir(parents=True, mode=0o700)
                auth = config_dir() / "auth"
                if auth.is_dir():
                    for file in auth.iterdir():
                        if file.is_file():
                            shutil.copyfile(file, profile / file.name)
                cookie = profile / "bilibili.cookies.txt"
                cookie.write_text(str(payload["cookieFile"]), encoding="utf-8")
                cookie.chmod(0o600)
                env["XDG_CONFIG_HOME"] = str(job["folder"] / "profile")
            executable = engine()
            with (job["folder"] / "stderr.log").open("w", encoding="utf-8") as errors:
                child = subprocess.Popen([executable, "run-task"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True, encoding="utf-8", env=env, start_new_session=sys.platform != "win32", **hidden())
                job["child"] = child
                child.stdin.write(json.dumps(request, ensure_ascii=False))
                child.stdin.close()
                done = None
                for line in child.stdout:
                    event = json.loads(line)
                    if event.get("type") == "done":
                        done = event
                    elif event.get("type") in ("error", "blocked"):
                        job["message"] = str(event.get("message", "CLI 任务失败"))
                    elif event.get("type") == "progress":
                        job.update(done=event.get("current", 0), total=event.get("total", 0), message=event.get("message") or event.get("stage", "处理中"))
                    elif event.get("type") == "stage":
                        job["message"] = str(event.get("stage", "处理中"))
                    elif event.get("type") == "log" and event.get("level", "").lower() in ("warn", "error"):
                        job["warnings"].append(str(event.get("message", "")))
                code = child.wait()
            if job["cancel"]:
                raise ValueError("任务已取消")
            if code or not done:
                message = job["message"] if job["message"] not in ("正在调用 course2md CLI", "render") else "course2md 未完成任务，请检查其运行环境"
                raise ValueError("\n".join([message, *job["warnings"][-2:]]))
            out = Path(done["out_dir"]).resolve()
            if not out.is_relative_to((job["folder"] / "course").resolve()):
                raise ValueError("CLI 返回了非本任务的输出目录")
        document = json.loads(safe_file(out, "document.json").read_text(encoding="utf-8"))
        manifest = json.loads(safe_file(out, "manifest.json").read_text(encoding="utf-8"))
        component = {"transcribe": "transcript", "frames": "screenshots", "polish": "proofreading"}[job["kind"]]
        outcome = manifest["outcomes"][component]
        if outcome["status"] != "succeeded":
            raise ValueError(outcome.get("message", "CLI 未完成所需处理"))
        speech = [e for section in document["sections"] for e in section["speech"]]
        if job["kind"] == "polish":
            by_time = collections.defaultdict(collections.deque)
            for item in speech:
                by_time[(item["start"], item["end"], item.get("raw") or item["text"])].append(item["text"])
            job["segments"] = []
            for item in payload["segments"]:
                matches = by_time[(item["start"], item["end"], item["text"])]
                job["segments"].append({"id": item["id"], "text": matches.popleft() if matches else ""})
        elif job["kind"] == "transcribe":
            collect(job)
            job["events"] = job["events"] or speech
            job["chunks"] = len(job["events"])
        if job["kind"] == "frames":
            job["images"] = [{"time": frame["t"], "data": "data:image/jpeg;base64," + base64.b64encode(safe_file(out, frame["image"]).read_bytes()).decode()} for frame in manifest["frames"]]
        if job["cancel"]:
            raise ValueError("任务已取消")
        job.update(state="done", message="已完成", out=out)
    except Exception as error:
        collect(job)
        job.update(state="error", error=str(error))
    finally:
        child = job.get("child")
        if child and child.poll() is None:
            cancel(job)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        os.utime(job["folder"], None)
        job.pop("child", None)
        if job["state"] == "done" and job["work"].is_dir():
            shutil.rmtree(job["work"])
        profile = job["folder"] / "profile"
        if profile.is_dir():
            shutil.rmtree(profile)


def snapshot(ident, after=0, image_after=0):
    job = JOBS.get(ident)
    if not job:
        raise ValueError("任务不存在")
    collect(job)
    images = []
    size = 0
    for frame in job["images"][max(0, int(image_after)):]:
        if images and (size + len(frame["data"]) > 8 * 1024 * 1024 or len(images) >= 16):
            break
        images.append(frame)
        size += len(frame["data"])
    return {**{key: job[key] for key in ("state", "message", "done", "total", "warnings", "error", "chunks", "segments") if key in job}, "events": job["events"][max(0, int(after)):], "images": images, "imagesTotal": len(job["images"])}


def cancel(job):
    if job["cancel"]:
        return
    job["cancel"] = True
    control = job["work"] / "control.json"
    control.parent.mkdir(parents=True, exist_ok=True)
    staged = control.with_suffix(".tmp")
    staged.write_text('{"intent":"cancel"}', encoding="utf-8")
    staged.replace(control)
    # The CLI's blocking HTTP calls may outlive cooperative cancellation.
    def stop_remaining():
        child = job.get("child")
        if child and child.poll() is None:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/pid", str(child.pid), "/t", "/f"], capture_output=True, **hidden())
            else:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
    timer = threading.Timer(1, stop_remaining)
    timer.daemon = True
    timer.start()


def expire_jobs():
    root = data_dir() / "bridge-jobs"
    if not root.is_dir():
        return
    for folder in root.iterdir():
        job = JOBS.get(folder.name)
        if job and (job["state"] == "running" or job.get("child")):
            continue
        if len(folder.name) == 32 and all(c in "0123456789abcdef" for c in folder.name) and folder.is_dir() and folder.resolve().is_relative_to(root.resolve()) and time.time() - folder.stat().st_mtime > 3600:
            shutil.rmtree(folder)
            JOBS.pop(folder.name, None)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def request(self):
        origin = self.headers.get("Origin", "")
        if origin and not origin.startswith("chrome-extension://"):
            return self.reply(403, {"error": "仅接受扩展请求"})
        if self.command == "GET" and self.path == "/health":
            return self.reply(200, {"ok": True, "engine": "course2md-cli"})
        if not hmac.compare_digest(self.headers.get("x-c2md-token", "").encode(), token().encode()):
            return self.reply(401, {"error": "缺少或错误的访问令牌"})
        try:
            url = urllib.parse.urlsplit(self.path)
            if self.command == "GET" and url.path in ("/asr/status", "/polish/status"):
                return self.reply(200, service_status("polish" if "polish" in url.path else "asr"))
            if self.command == "POST" and url.path == "/shutdown":
                for job in list(JOBS.values()):
                    if job["state"] == "running":
                        cancel(job)
                self.reply(200, {"ok": True})
                threading.Thread(target=self.server.shutdown).start()
                return
            if url.path.startswith("/jobs/"):
                ident = url.path[6:]
                if self.command == "GET":
                    query = urllib.parse.parse_qs(url.query)
                    return self.reply(200, snapshot(ident, query.get("after", [0])[0], query.get("imageAfter", [0])[0]))
                if self.command == "DELETE":
                    job = JOBS.get(ident)
                    if job and job["state"] == "running":
                        cancel(job)
                    return self.reply(200, {"cancelled": bool(job)})
            if self.command == "POST" and url.path in ("/asr/start", "/polish/start"):
                return self.reply(200, service_status("polish" if "polish" in url.path else "asr"))
            kind = {"/transcribe": "transcribe", "/frames": "frames", "/polish": "polish", "/desktop/publish": "desktop"}.get(url.path)
            if self.command == "POST" and kind:
                size = int(self.headers.get("Content-Length", 0))
                if size < 1 or size > (desktop_sync.LIMIT if kind == "desktop" else 16 * 1024 * 1024):
                    raise ValueError("请求大小无效")
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError("请求必须为 JSON 对象")
                if kind == "desktop":
                    return self.reply(200, desktop_sync.publish_snapshot(payload))
                # ponytail: one process owns the small job cache; use persistent tasks if reconnects across restarts are needed.
                expire_jobs()
                return self.reply(200, start_job(kind, payload))
            self.reply(404, {"error": "not found"})
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            self.reply(400, {"error": str(error)})

    do_GET = do_POST = do_DELETE = request


def native_host():
    size = sys.stdin.buffer.read(4)
    if len(size) != 4:
        return
    length = struct.unpack("<I", size)[0]
    result = {"ok": False}
    try:
        config = Path(__file__).resolve().parents[2] / "native-helper.config"
        python, script, health, token_file = config.read_text(encoding="utf-8").splitlines()[:4]
        if not 1 <= length <= 4096 or json.loads(sys.stdin.buffer.read(length)).get("action") != "start":
            raise ValueError("无效的本机消息")
        # Loopback health must bypass system proxies, including macOS proxy discovery.
        local = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def healthy():
            try:
                with local.open(health, timeout=.5) as response:
                    return response.status == 200 and json.load(response).get("engine") == "course2md-cli"
            except (OSError, ValueError):
                return False
        if not healthy():
            env = dict(os.environ, C2MD_DATA_DIR=str(Path(token_file).parent))
            with (Path(token_file).parent / "native-helper.log").open("w", encoding="utf-8") as errors:
                child = subprocess.Popen([python, script], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors, env=env, start_new_session=sys.platform != "win32", **hidden())
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if healthy():
                    break
                if child.poll() is not None:
                    raise ValueError(f"MizoreLink 进程启动失败（代码 {child.returncode}，详见 native-helper.log）")
                time.sleep(.2)
        if not healthy():
            raise ValueError("MizoreLink 连接超时")
        result = {"ok": True, "token": Path(token_file).read_text().strip()}
    except (OSError, ValueError) as error:
        result["error"] = str(error)
    body = json.dumps(result).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    if "--native-host" in sys.argv:
        native_host()
    else:
        token()
        with LoopbackServer(("127.0.0.1", int(os.environ.get("C2MD_HELPER_PORT", 8766))), Handler) as server:
            server.serve_forever()
