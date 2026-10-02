"""Check write-only note exports and the course2md engine's artifact contract."""
import base64
import copy
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("desktop_sync", Path(__file__).resolve().parents[1] / "tools/desktop_sync.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class DesktopSyncTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "config"
        self.config.mkdir()
        self.library = self.root / "notes"
        self.library.mkdir()
        self.workspace = self.config / "desktop-workspace.json"
        self.workspace.write_bytes(bridge.encoded({"schema": 1, "default_library": "chosen", "libraries": [
            {"id": "other", "root": str(self.root)}, {"id": "chosen", "root": str(self.library)}]}))
        self.env = patch.dict(os.environ, C2MD_UPSTREAM_CONFIG=str(self.config))
        self.env.start()
        self.addCleanup(self.env.stop)
        self.payload = {
            "requestId": "test-1",
            "document": {"schema": 1, "meta": {"title": "课程", "uploader": "讲者", "duration": 20,
                "webpage_url": "https://www.bilibili.com/video/BV1CAxaeHEeH?p=2", "extractor": "bilibili", "id": "BV1CAxaeHEeH"},
                "sections": [{"t": 0, "end": 20, "image": "frames/slide_0001.png", "speech": [
                    {"start": 0, "end": 12, "text": "正文", "raw": "原始正文"}]}], "summary": None},
            "web": {"generator": {"name": "course2md-web", "version": "0.4.0"}, "meta": {"polished": True}, "sections": []},
            "images": {"frames/slide_0001.png": "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nexample").decode()},
            "markdown": "# 课程\n", "events": [{"start": 0, "end": 1, "text": "未经转换的原文"}],
        }

    def publish(self):
        return bridge.publish_snapshot(copy.deepcopy(self.payload))

    def test_uses_desktop_selection_without_editing_its_workspace(self):
        before = self.workspace.read_bytes()
        self.assertEqual(bridge.default_root(), self.library.resolve())
        with patch.dict(os.environ, C2MD_UPSTREAM_CONFIG=str(self.config / "config.toml")):
            self.assertEqual(bridge.default_root(), self.library.resolve())
        self.publish()
        self.assertEqual(self.workspace.read_bytes(), before)
        self.workspace.unlink()
        root = bridge.default_root()
        self.assertEqual(root, (self.config / "desktop-local-library").resolve())
        self.assertFalse(self.workspace.exists())
        self.workspace.write_bytes(bridge.encoded({"schema": 1, "default_library": "gone",
            "libraries": [{"id": "gone", "root": str(self.root / "missing")}]}))
        with self.assertRaisesRegex(ValueError, "保存位置不可用"):
            self.publish()
        self.workspace.write_bytes(bridge.encoded({"schema": 1, "default_library": "gone", "libraries": []}))
        with self.assertRaisesRegex(ValueError, "保存位置不可用"):
            self.publish()

    def test_preserves_text_frames_source_and_asset_integrity(self):
        saved = self.publish()
        manifest, document, directory = bridge.current(self.library / saved["course"])
        self.assertEqual(manifest["source_id"], "online:bilibili:15:BV1CAxaeHEeH_p2")
        self.assertEqual(document["sections"][0]["speech"][0]["raw"], "原始正文")
        for asset in manifest["assets"]:
            data = (directory / asset["path"]).read_bytes()
            self.assertEqual(asset["bytes"], len(data))
            self.assertEqual(asset["sha256"], bridge.digest(data))
        self.assertEqual(json.loads((directory / "timeline.jsonl").read_text(encoding="utf-8"))["text"], "未经转换的原文")
        self.assertEqual((directory / "course.md").read_text(encoding="utf-8"), self.payload["markdown"])

    def test_retry_never_replaces_content_or_rolls_back_a_newer_version(self):
        first = self.publish()
        self.assertEqual(self.publish(), first)
        self.payload["requestId"] = "test-2"
        second = self.publish()
        self.payload["requestId"] = "test-1"
        self.publish()
        manifest = bridge.current(self.library / first["course"])[0]
        self.assertEqual(manifest["version_id"], second["version"])
        self.assertEqual(manifest["revision"], 2)
        self.payload["markdown"] = "changed"
        with self.assertRaisesRegex(ValueError, "身份重复"):
            self.publish()

    def test_interrupted_pointer_commit_recovers_without_republishing(self):
        original = bridge.atomic

        def interrupt(file, data):
            if file.name == "current.json":
                raise OSError("simulated interruption")
            original(file, data)

        with patch.object(bridge, "atomic", side_effect=interrupt):
            with self.assertRaises(OSError):
                self.publish()
        saved = self.publish()
        self.assertEqual(len(list((self.library / saved["course"] / "versions").iterdir())), 1)
        self.assertEqual(bridge.current(self.library / saved["course"])[0]["revision"], 1)

    def test_corrupt_or_escaping_assets_cannot_replace_saved_notes(self):
        saved = self.publish()
        course = self.library / saved["course"]
        directory = course / "versions" / saved["version"]
        pointer = (course / "current.json").read_bytes()
        (directory / "frames/slide_0001.png").write_bytes(b"changed")
        self.payload["requestId"] = "test-2"
        with self.assertRaisesRegex(ValueError, "损坏"):
            self.publish()
        self.assertEqual((course / "current.json").read_bytes(), pointer)
        for relative in ("../private", "/etc/passwd", "C:/Windows/win.ini", "a\\b", "a/../b"):
            with self.assertRaises(ValueError):
                bridge.safe(self.library, relative)
        self.payload["document"]["sections"][0]["speech"][0]["end"] = float("nan")
        with self.assertRaisesRegex(ValueError, "有限非负"):
            self.publish()

    def test_process_locks_conflict_and_release(self):
        lock = self.library / ".publish.lock"
        script = f"import sys; sys.path.insert(0, {str(Path(bridge.__file__).parent)!r}); import desktop_sync; from pathlib import Path;\nwith desktop_sync.file_lock(Path({str(lock)!r})): print('locked')"
        with bridge.file_lock(lock):
            process = subprocess.run([sys.executable, "-c", script], capture_output=True)
            self.assertNotEqual(process.returncode, 0)
        process = subprocess.run([sys.executable, "-c", script], capture_output=True)
        self.assertEqual(process.returncode, 0, process.stderr)

    @unittest.skipUnless(os.environ.get("C2MD_UPSTREAM_EXE"), "real CLI selected only for interoperability checks")
    def test_latest_engine_reprocesses_and_shares_publish_lock(self):
        class Llm(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                summary = json.dumps({"tldr": "测试摘要", "key_points": ["正文"], "outline": [{"t": 0, "title": "课程", "detail": "说明"}]})
                data = json.dumps({"choices": [{"message": {"content": summary}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Llm)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        saved = self.publish()
        course = self.library / saved["course"]
        manifest, _, directory = bridge.current(course)
        request = {"schema": 1, "operation": {"kind": "reprocess", "base_version_dir": str(directory), "components": ["summary", "exports"]},
            "task_id": "native-test", "course_id": saved["course"], "version_id": "native-test",
            "source": self.payload["document"]["meta"]["webpage_url"], "source_id": manifest["source_id"], "title": "课程",
            "config": {"defaults": {"formats": ["md", "html", "json"]},
                       "llm": {"base_url": f"http://127.0.0.1:{server.server_port}/v1", "model": "fixture", "api_key": "fixture"}},
            "work_dir": str(self.root / "native-work"), "course_dir": str(course)}

        def call():
            return subprocess.run([os.environ["C2MD_UPSTREAM_EXE"], "run-task"], input=bridge.encoded(request), capture_output=True, timeout=30)

        with bridge.file_lock(course / ".publish.lock"):
            blocked = call()
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn(b"Directory is in use", blocked.stdout + blocked.stderr)
        result = call()
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr).decode("utf-8", errors="replace"))
        events = [json.loads(line) for line in result.stdout.splitlines()]
        done = next(event for event in events if event["type"] == "done")
        self.assertFalse(done["partial"])
        self.assertEqual({Path(path).name for path in done["outputs"]}, {"course.zip", "course.html", "structured.json"})
        native = bridge.current(course)[0]
        self.assertEqual(native["version_id"], "native-test")
        self.assertEqual(native["revision"], 2)
        self.assertEqual(set(native["outputs"]), {"exports/course.zip", "exports/course.html", "exports/structured.json"})
        self.assertEqual(self.publish(), saved)
        self.assertEqual(bridge.current(course)[0]["version_id"], "native-test")


if __name__ == "__main__":
    unittest.main()
