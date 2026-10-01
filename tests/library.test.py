import base64
import copy
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("library", Path(__file__).resolve().parents[1] / "tools" / "library.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class LibraryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "helper"
        self.data.mkdir()
        self.library = self.root / "courses"
        self.library.mkdir()
        self.config = self.root / "config"
        self.config.mkdir()
        self.env = patch.dict(os.environ, C2MD_UPSTREAM_CONFIG=str(self.config))
        self.env.start()
        self.addCleanup(self.env.stop)
        self.identifier = bridge.handle("connect", {"root": str(self.library)}, self.data)["libraries"][0]["id"]
        self.payload = {
            "library": self.identifier, "requestId": "test-1",
            "document": {"schema": 1, "meta": {"title": "课程", "uploader": "讲者", "duration": 20,
              "webpage_url": "https://www.bilibili.com/video/BV1CAxaeHEeH?p=2", "extractor": "bilibili", "id": "BV1CAxaeHEeH"},
              "sections": [{"t": 0, "end": 20, "image": "frames/slide_0001.png", "speech": [{"start": 0, "end": 12, "text": "正文", "raw": "原始正文"}]}], "summary": None},
            "web": {"generator": {"name": "course2md-web", "version": "0.4.0"}, "meta": {"polished": True}, "sections": []},
            "images": {"frames/slide_0001.png": "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nexample").decode()},
            "markdown": "# 课程\n", "events": [{"start": 0, "end": 1, "text": "未经转换的原文"}],
        }

    def publish(self):
        return bridge.handle("publish", copy.deepcopy(self.payload), self.data)

    def test_roundtrip_and_native_contract(self):
        saved = self.publish()
        read = bridge.handle("read", saved, self.data)
        self.assertEqual(read["manifest"]["source_id"], "online:bilibili:15:BV1CAxaeHEeH_p2")
        self.assertEqual(read["manifest"]["revision"], 1)
        self.assertEqual(read["document"]["sections"][0]["speech"][0]["raw"], "原始正文")
        directory = self.library / saved["course"] / "versions" / saved["version"]
        for asset in read["manifest"]["assets"]:
            data = (directory / asset["path"]).read_bytes()
            self.assertEqual(asset["bytes"], len(data))
            self.assertEqual(asset["sha256"], bridge.digest(data))
        self.assertEqual(json.loads((directory / "timeline.jsonl").read_text(encoding="utf-8"))["text"], "未经转换的原文")
        self.assertEqual(bridge.handle("list", {"library": self.identifier}, self.data)["courses"][0]["version"], saved["version"])
        self.assertTrue(bridge.handle("image", {**saved, "image": "frames/slide_0001.png"}, self.data)["data"].startswith("data:image/png;"))

    def test_retry_does_not_roll_back_or_replace(self):
        first = self.publish()
        self.assertEqual(self.publish(), first)
        self.payload["requestId"] = "test-2"
        second = self.publish()
        self.payload["requestId"] = "test-1"
        self.publish()
        current = bridge.current(self.library / first["course"])[0]
        self.assertEqual(current["version_id"], second["version"])
        self.assertEqual(current["revision"], 2)
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

    def test_corruption_and_path_escape(self):
        saved = self.publish()
        directory = self.library / saved["course"] / "versions" / saved["version"]
        (directory / "frames" / "slide_0001.png").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "损坏"):
            bridge.handle("read", saved, self.data)
        with self.assertRaisesRegex(ValueError, "损坏"):
            bridge.handle("image", {**saved, "image": "frames/slide_0001.png"}, self.data)
        for relative in ("../private", "/etc/passwd", "C:/Windows/win.ini", "a\\b", "a/../b"):
            with self.assertRaises(ValueError):
                bridge.safe(self.library, relative)
        with self.assertRaises(ValueError):
            bridge.handle("read", {"library": "unknown", "course": saved["course"]}, self.data)
        with self.assertRaises(ValueError):
            bridge.handle("connect", {"root": "relative"}, self.data)

    def test_bad_current_can_read_previous_without_changing_pointer(self):
        first = self.publish()
        self.payload["requestId"] = "test-2"
        second = self.publish()
        directory = self.library / second["course"] / "versions" / second["version"]
        (directory / "document.json").write_bytes(b"broken")
        pointer = (self.library / first["course"] / "current.json").read_bytes()
        read = bridge.handle("read", {"library": self.identifier, "course": first["course"]}, self.data)
        self.assertEqual(read["manifest"]["version_id"], first["version"])
        self.assertTrue(read["warnings"])
        self.assertEqual((self.library / first["course"] / "current.json").read_bytes(), pointer)

    def test_process_lock_conflicts_and_releases(self):
        lock = self.library / ".publish.lock"
        script = f"import sys; sys.path.insert(0, {str(Path(bridge.__file__).parent)!r}); import library; from pathlib import Path;\nwith library.file_lock(Path({str(lock)!r})): print('locked')"
        with bridge.file_lock(lock):
            process = subprocess.run([sys.executable, "-c", script], capture_output=True)
            self.assertNotEqual(process.returncode, 0)
        process = subprocess.run([sys.executable, "-c", script], capture_output=True)
        self.assertEqual(process.returncode, 0, process.stderr)

    def test_discovery_preserves_original_workspace_and_metadata(self):
        workspace = self.config / "desktop-workspace.json"
        body = {"schema": 1, "libraries": [{"id": "original", "name": "原课程库", "root": str(self.library)}]}
        workspace.write_bytes(bridge.encoded(body))
        before = workspace.read_bytes()
        self.assertEqual(len(bridge.libraries(self.data)["libraries"]), 1)
        self.assertEqual(bridge.libraries(self.data)["libraries"][0]["name"], "原课程库")
        saved = self.publish()
        (self.library / ".course2md-titles.json").write_bytes(bridge.encoded({"names": {saved["course"]: "别名"}}))
        result = bridge.handle("list", {"library": self.identifier}, self.data)
        self.assertEqual(result["courses"][0]["title"], "别名")
        self.assertEqual(workspace.read_bytes(), before)

    def test_identity_and_invalid_times(self):
        first = bridge.source_identity(self.payload["document"]["meta"])[0]
        self.payload["document"]["meta"]["webpage_url"] = "https://www.bilibili.com/video/BV1CAxaeHEeH?p=3"
        self.assertNotEqual(first, bridge.source_identity(self.payload["document"]["meta"])[0])
        self.payload["document"]["sections"][0]["speech"][0]["start"] = float("nan")
        with self.assertRaises(ValueError):
            self.publish()

    @unittest.skipUnless(os.environ.get("C2MD_UPSTREAM_EXE"), "set C2MD_UPSTREAM_EXE for real engine conformance")
    def test_latest_engine_reprocesses_and_shares_publish_lock(self):
        # A deterministic localhost LLM avoids credentials, outside network and model downloads.
        class Llm(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                content = json.dumps({"tldr": "测试摘要", "key_points": ["正文"], "outline": [{"t": 0, "title": "课程", "detail": "说明"}]})
                body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Llm)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        saved = self.publish()
        directory = self.library / saved["course"] / "versions" / saved["version"]
        manifest = bridge.current(self.library / saved["course"])[0]
        tool = bridge.handle("engine", {"path": os.environ["C2MD_UPSTREAM_EXE"]}, self.data)
        self.assertTrue(tool["available"])
        exported = bridge.handle("export", {**saved, "format": "md"}, self.data)
        self.assertEqual(Path(exported["outputs"][0]).name, "course.zip")
        self.assertEqual(bridge.current(self.library / saved["course"])[0]["version_id"], saved["version"])
        request = {"schema": 1, "operation": {"kind": "reprocess", "base_version_dir": str(directory), "components": ["summary", "exports"]},
                   "task_id": "native-test", "course_id": saved["course"], "version_id": "native-test",
                   "source": self.payload["document"]["meta"]["webpage_url"], "source_id": manifest["source_id"], "title": "课程",
                   "config": {"defaults": {"formats": ["md", "html", "json"]}, "llm": {"base_url": f"http://127.0.0.1:{server.server_port}/v1", "model": "fixture", "api_key": "fixture"}}, "work_dir": str(self.root / "native-work"),
                   "course_dir": str(self.library / saved["course"])}
        def call():
            return subprocess.run([os.environ["C2MD_UPSTREAM_EXE"], "run-task"], input=bridge.encoded(request), capture_output=True, timeout=30)
        with bridge.file_lock(self.library / saved["course"] / ".publish.lock"):
            blocked = call()
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn(b"Directory is in use", blocked.stdout + blocked.stderr)
        native = call()
        self.assertEqual(native.returncode, 0, (native.stdout + native.stderr).decode("utf-8", errors="replace"))
        result = bridge.handle("read", {"library": self.identifier, "course": saved["course"]}, self.data)
        self.assertEqual(result["manifest"]["version_id"], "native-test")
        self.assertEqual(result["manifest"]["revision"], 2)
        self.assertEqual(set(result["manifest"]["outputs"]), {"exports/course.zip", "exports/course.html", "exports/structured.json"})
        self.assertIsNone(result["web"], "原版重处理产物使用原版文档读取")
        self.publish()
        self.assertEqual(bridge.current(self.library / saved["course"])[0]["version_id"], "native-test")


if __name__ == "__main__":
    import sys
    unittest.main()
