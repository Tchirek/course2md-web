"""Exercise the real CLI with small local media and loopback ASR/LLM endpoints."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler
from unittest.mock import patch
import cli_bridge as bridge


def cli():
    if os.environ.get("C2MD_UPSTREAM_EXE"):
        return Path(os.environ["C2MD_UPSTREAM_EXE"])
    pins = json.loads(Path(__file__).with_name("engine-pins.json").read_text())
    system = {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")
    arch = "aarch64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
    pin = pins["assets"][f"{system}-{arch}"]
    file = Path(tempfile.gettempdir()) / "course2md-web-check" / pins["version"] / pin["name"]
    file.parent.mkdir(parents=True, exist_ok=True)
    if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != pin["sha256"]:
        url = f"https://github.com/mizorewww/course2md/releases/download/{pins['version']}/{pin['name']}"
        with urllib.request.urlopen(url, timeout=90) as response:
            body = response.read(pin["bytes"] + 1)
        assert len(body) == pin["bytes"] and hashlib.sha256(body).hexdigest() == pin["sha256"], "CLI asset checksum mismatch"
        file.write_bytes(body)
    file.chmod(0o755)
    return file


CALLS = []
WAITING = threading.Event()
RELEASE = threading.Event()


class Endpoint(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path.endswith("/audio/transcriptions"):
            CALLS.append("asr")
            result = {"text": "hello cli", "segments": [{"start": 0, "end": 2, "text": "hello cli"}]}
        else:
            request = json.loads(body)
            if "Wait for cancellation" in request["messages"][0]["content"]:
                WAITING.set()
                RELEASE.wait(8)
            content = request["messages"][-1]["content"]
            text = content if isinstance(content, str) else next(item["text"] for item in content if item["type"] == "text")
            segments = json.loads(text)
            CALLS.append(request)
            reply = {"segments": [{"id": item["id"], "text": "" if item["text"] == "remove" else item["text"].upper()} for item in segments]}
            result = {"choices": [{"message": {"content": json.dumps(reply)}}]}
        data = json.dumps(result).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A cancelled CLI has already closed the connection.


def finish(kind, payload):
    ident = bridge.start_job(kind, payload)["id"]
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        result = bridge.snapshot(ident)
        if result["state"] != "running":
            assert result["state"] == "done", result.get("error", result)
            return result
        time.sleep(.05)
    bridge.cancel(bridge.JOBS[ident])
    raise AssertionError(f"{kind} timed out")


def main():
    executable = cli().resolve()
    env = dict(os.environ, C2MD_UPSTREAM_EXE=str(executable))
    test_file = Path(__file__).resolve().parents[1] / "tests/desktop-sync.test.py"
    # Source checkouts test interoperability; the connection ZIP contains no test fixtures.
    if test_file.is_file():
        subprocess.run([sys.executable, str(test_file), "DesktopSyncTest.test_latest_engine_reprocesses_and_shares_publish_lock"],
                       env=env, check=True, **bridge.hidden())
    with tempfile.TemporaryDirectory(prefix="course2md-cli-", suffix=" space") as scratch:
        root = Path(scratch)
        os.environ.update(C2MD_DATA_DIR=str(root / "data"), C2MD_UPSTREAM_EXE=str(executable), XDG_CONFIG_HOME=str(root / "config"), C2MD_UPSTREAM_CONFIG=str(root / "config/course2md/config.toml"))
        with patch("socket.getfqdn", side_effect=AssertionError("Loopback must not use DNS")):
            endpoint = bridge.LoopbackServer(("127.0.0.1", 0), Endpoint)
        threading.Thread(target=endpoint.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{endpoint.server_port}/v1"
        config = Path(os.environ["C2MD_UPSTREAM_CONFIG"])
        config.parent.mkdir(parents=True)
        original = f'[defaults]\nprovider="api"\n[asr_api]\nbase_url="{base}"\napi_key="test-secret"\nmodel="test-asr"\n[llm]\nenabled=true\nbase_url="{base}"\napi_key="test-secret"\nmodel="test-llm"\n'
        config.write_text(original, encoding="utf-8")
        assert bridge.service_status("polish")["state"] == "ready"
        segments = [{"id": 7, "start": 0, "end": 1, "text": "hello"}, {"id": 8, "start": 1, "end": 2, "text": "remove"}, {"id": 9, "start": 2, "end": 3, "text": "world"}]
        try:
            polished = finish("polish", {"segments": segments, "instruction": "Keep terms: Web", "title": "a title"})
            assert polished["segments"] == [{"id": 7, "text": "HELLO"}, {"id": 8, "text": ""}, {"id": 9, "text": "WORLD"}], polished
            assert "Keep terms: Web" in CALLS[-1]["messages"][0]["content"]
            media = root / "local video.mp4"
            ffmpeg = shutil.which("ffmpeg") or str(executable.parent / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"))
            subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=5", "-f", "lavfi", "-i", "sine=frequency=600", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", str(media)], check=True, **bridge.hidden())
            frames = finish("frames", {"sourceUrl": media.as_uri(), "duration": 3})
            assert frames["images"] and frames["images"][0]["time"] == 0
            assert frames["images"][0]["data"].startswith("data:image/jpeg;base64,")
            transcript = finish("transcribe", {"sourceUrl": media.as_uri(), "endpoint": "cli", "duration": 3})
            assert any(item["text"] == "hello cli" for item in transcript["events"]), transcript
            assert "asr" in CALLS and config.read_text(encoding="utf-8") == original
            ident = bridge.start_job("polish", {"segments": segments, "instruction": "Wait for cancellation"})["id"]
            assert WAITING.wait(5), "CLI did not reach the test endpoint"
            bridge.cancel(bridge.JOBS[ident])
            deadline = time.monotonic() + 3
            while bridge.JOBS[ident]["state"] == "running" and time.monotonic() < deadline:
                time.sleep(.05)
            assert bridge.JOBS[ident]["state"] == "error", "CLI cancellation did not stop the task"
            RELEASE.set()
            try:
                bridge.safe_file(root, "../outside.txt")
                raise AssertionError("outside output accepted")
            except ValueError:
                pass
            paged = dict(next(job for job in bridge.JOBS.values() if job["kind"] == "frames"), images=[{"time": i, "data": "x"} for i in range(33)])
            bridge.JOBS["pages"] = paged
            assert len(bridge.snapshot("pages")["images"]) == 16
            assert [item["time"] for item in bridge.snapshot("pages", image_after=16)["images"]] == list(range(16, 32))
            assert bridge.snapshot("pages", image_after=32)["imagesTotal"] == 33
            del bridge.JOBS["pages"]
            orphan = root / "data/bridge-jobs" / ("d" * 32)
            orphan.mkdir()
            os.utime(orphan, (0, 0))
            untouched = orphan.parent / "user-folder"
            untouched.mkdir()
            os.utime(untouched, (0, 0))
            bridge.expire_jobs()
            assert not orphan.exists() and untouched.is_dir(), "cache cleanup removed unrelated data"
            print("CLI: real proofreading, removals, screenshots, ASR, cancellation and config isolation passed")
        finally:
            RELEASE.set()
            endpoint.shutdown()
            for job in bridge.JOBS.values():
                if job["state"] == "running":
                    bridge.cancel(job)
            bridge.POOL.shutdown(wait=True)
            assert all(not job["work"].exists() for job in bridge.JOBS.values() if job["state"] == "done"), "successful media work was retained"


if __name__ == "__main__":
    main()
