"""Write-only course2md note export. Desktop owns reading and library management."""
import base64
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlparse

LIMIT = 64 * 1024 * 1024


def read_json(file):
    if file.stat().st_size > LIMIT:
        raise ValueError("课程文件过大")
    return json.loads(file.read_text(encoding="utf-8"))


def safe(root, relative):
    if not isinstance(relative, str) or "\\" in relative or ":" in relative:
        raise ValueError("无效的课程文件路径")
    parts = relative.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError("无效的课程文件路径")
    file = root.joinpath(*parts).resolve()
    if file == root.resolve() or not file.is_relative_to(root.resolve()):
        raise ValueError("课程文件越出保存位置")
    return file


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sync_dir(directory):
    if os.name != "nt":
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def atomic(file, data):
    fd, temporary = tempfile.mkstemp(prefix=".web-writing-", dir=file.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        sync_dir(file.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8") + b"\n"



@contextlib.contextmanager
def file_lock(file):
    # Rust std::fs::File::try_lock uses LockFileEx on Windows and flock on Unix.
    with file.open("a+b") as stream:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            import msvcrt

            class Overlapped(ctypes.Structure):
                _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                            ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                            ("hEvent", wintypes.HANDLE)]

            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                         wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
            kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                           wintypes.DWORD, ctypes.POINTER(Overlapped)]
            overlap = Overlapped()
            handle = msvcrt.get_osfhandle(stream.fileno())
            if not kernel.LockFileEx(handle, 3, 0, 0xFFFFFFFF, 0xFFFFFFFF, ctypes.byref(overlap)):
                raise ValueError("课程正在被另一任务保存，请稍后重试")
            try:
                yield
            finally:
                kernel.UnlockFileEx(handle, 0, 0xFFFFFFFF, 0xFFFFFFFF, ctypes.byref(overlap))
        else:
            import fcntl
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ValueError("课程正在被另一任务保存，请稍后重试") from error
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)


def config_dir():
    explicit = os.environ.get("C2MD_UPSTREAM_CONFIG")
    if explicit:
        path = Path(explicit)
        return path.parent if path.suffix.lower() == ".toml" else path
    if os.environ.get("XDG_CONFIG_HOME"):
        return Path(os.environ["XDG_CONFIG_HOME"]) / "course2md"
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "course2md"
    return Path.home() / ".config" / "course2md"


def validate_document(document):
    if document.get("schema") != 1 or not isinstance(document.get("meta"), dict):
        raise ValueError("不支持此课程文档版本")
    meta = document["meta"]
    for name in ("title", "uploader", "webpage_url", "extractor", "id"):
        if not isinstance(meta.get(name), str):
            raise ValueError("课程元信息无效")
    finite_time(meta.get("duration"))
    readable = False
    previous = -1
    for section in document["sections"]:
        t = finite_time(section["t"])
        if t < previous or finite_time(section["end"]) < t:
            raise ValueError("课程时间线无效")
        previous = t
        if not isinstance(section["image"], str):
            raise ValueError("课程图片无效")
        for event in section["speech"]:
            if finite_time(event["end"]) < finite_time(event["start"]):
                raise ValueError("段落结束早于开始")
            if not isinstance(event["text"], str) or ("raw" in event and not isinstance(event["raw"], str)):
                raise ValueError("段落文字无效")
            readable |= bool(event["text"].strip())
    if not readable:
        raise ValueError("课程没有可读正文")


def finite_time(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("课程时间必须是有限非负数")
    return value


def version(course, relative, verify=True, staged=False):
    file = safe(course, relative)
    manifest = read_json(file)
    if manifest.get("schema") != 1 or (not staged and file.parent.name != manifest.get("version_id")):
        raise ValueError("不支持此课程清单版本或身份不符")
    directory = file.parent
    for asset in manifest["assets"]:
        target = safe(directory, asset["path"])
        if verify and not asset["path"].startswith("exports/"):
            data = target.read_bytes() if target.stat().st_size <= LIMIT else b""
            if len(data) != asset["bytes"] or digest(data) != asset["sha256"]:
                raise ValueError(f"课程文件已更改或损坏：{asset['path']}")
    document = read_json(safe(directory, manifest["document"]))
    validate_document(document)
    for frame in manifest["frames"]:
        if not safe(directory, frame["image"]).is_file():
            raise ValueError("课程画面丢失")
    return manifest, document, directory


def current(course, verify=True):
    pointer = read_json(safe(course, "current.json"))
    if pointer.get("schema") != 1 or pointer["manifest"] != f"versions/{pointer['version_id']}/manifest.json":
        raise ValueError("课程版本指针无效")
    result = version(course, pointer["manifest"], verify)
    if result[0]["course_id"] != pointer["course_id"]:
        raise ValueError("课程版本身份不符")
    return result


def source_identity(meta):
    url = urlparse(meta["webpage_url"])
    host = (url.hostname or "").lower()
    if url.scheme not in ("http", "https"):
        raise ValueError("保存课程需要有效的视频来源网址")
    identifier, extractor = "", ""
    if host == "youtube.com" or host.endswith(".youtube.com"):
        identifier = parse_qs(url.query).get("v", [""])[0]
        extractor = "youtube"
    elif host == "youtu.be":
        identifier, extractor = url.path.strip("/"), "youtube"
    elif host == "bilibili.com" or host.endswith(".bilibili.com"):
        match = re.search(r"/video/(BV[A-Za-z0-9]+)", url.path)
        identifier, extractor = (match.group(1) if match else ""), "bilibili"
        part = parse_qs(url.query).get("p", [""])[0]
        if re.fullmatch(r"[1-9]\d*", part):
            identifier += "_p" + part
    if identifier:
        return f"online:{extractor}:{len(identifier.encode('utf-8'))}:{identifier}", extractor, identifier
    # Generic pages don't expose yt-dlp's extractor ID. Keep an honest independent identity.
    return "web:url:" + digest(meta["webpage_url"].encode()), meta["extractor"], meta["id"]


def publish(root, payload):
    document = payload["document"]
    validate_document(document)
    source_id, extractor, identifier = source_identity(document["meta"])
    document["meta"].update(extractor=extractor, id=identifier)
    course_id = "course-" + digest(source_id.encode())[:32]
    course = safe(root, course_id)
    course.mkdir(exist_ok=True)
    request_id = payload["requestId"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id):
        raise ValueError("无效的保存请求身份")
    version_id = "web-" + request_id
    fingerprint = digest(encoded({key: payload[key] for key in ("document", "web", "images", "markdown", "events")}))
    with file_lock(safe(course, ".publish.lock")):
        versions = safe(course, "versions")
        versions.mkdir(exist_ok=True)
        target = safe(versions, version_id)
        previous = current(course) if (course / "current.json").exists() else None
        if previous and previous[0]["source_id"] != source_id:
            raise ValueError("保存位置的来源身份冲突，旧笔记已保留")
        if target.exists():
            manifest, _, _ = version(course, f"versions/{version_id}/manifest.json")
            provenance = read_json(safe(target, "web-provenance.json"))
            if provenance["fingerprint"] != fingerprint:
                raise ValueError("保存请求身份重复但内容不同")
        else:
            staging = Path(tempfile.mkdtemp(prefix=".publishing-web-", dir=versions))
            try:
                images = payload["images"]
                used = {s["image"] for s in document["sections"] if s["image"]}
                if used != set(images):
                    raise ValueError("课程图片清单与正文不符")
                for name, data in images.items():
                    match = re.fullmatch(r"data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)", data)
                    if not match or not re.fullmatch(r"frames/slide_\d+\.(jpg|png|webp)", name):
                        raise ValueError("无效的课程图片")
                    image = base64.b64decode(match[2], validate=True)
                    if not (image.startswith(b"\xff\xd8\xff") or image.startswith(b"\x89PNG\r\n\x1a\n") or (image.startswith(b"RIFF") and image[8:12] == b"WEBP")):
                        raise ValueError("课程图片内容与格式不符")
                    destination = safe(staging, name)
                    destination.parent.mkdir(exist_ok=True)
                    atomic(destination, image)
                atomic(staging / "document.json", encoded(document))
                atomic(staging / "meta.json", encoded(document["meta"]))
                atomic(staging / "course.md", payload["markdown"].encode())
                atomic(staging / "web-document.json", encoded(payload["web"]))
                atomic(staging / "web-provenance.json", encoded({"generator": payload["web"]["generator"], "fingerprint": fingerprint}))
                events = payload["events"]
                for event in events:
                    finite_time(event["start"])
                    if finite_time(event["end"]) < event["start"] or not isinstance(event["text"], str):
                        raise ValueError("原始字幕时间线无效")
                if events:
                    atomic(staging / "timeline.jsonl", b"".join(json.dumps({"type": "speech", **event}, ensure_ascii=False, allow_nan=False).encode() + b"\n" for event in events))
                assets = [{"path": file.relative_to(staging).as_posix(), "bytes": file.stat().st_size, "sha256": digest(file.read_bytes())}
                          for file in sorted(staging.rglob("*")) if file.is_file()]
                success, skipped = {"status": "succeeded"}, {"status": "not_requested"}
                expected_images = len({f["t"] for s in payload["web"]["sections"] for f in s.get("frames", [])})
                screenshots = success if images else skipped
                if expected_images > len(images) or (not images and payload["web"]["meta"].get("imageLevel", "none") != "none"):
                    screenshots = {"status": "partial", "message": "网页画面未全部取得", "completed": len(images), "total": expected_images}
                manifest = {"schema": 1, "task_id": version_id, "course_id": course_id, "source_id": source_id,
                            "version_id": version_id, "title": document["meta"]["title"], "created_at_ms": int(time.time() * 1000),
                            "revision": previous[0]["revision"] + 1 if previous else 1, "document": "document.json", "markdown": "course.md",
                            "frames": [{"t": s["t"], "image": s["image"]} for s in document["sections"] if s["image"]],
                            "assets": assets, "outputs": [], "partial": screenshots["status"] == "partial",
                            "outcomes": {"transcript": success, "screenshots": screenshots,
                                         "proofreading": success if payload["web"]["meta"].get("polished") else skipped,
                                         "summary": skipped, "exports": {}}}
                atomic(staging / "manifest.json", encoded(manifest))
                version(course, staging.relative_to(course).as_posix() + "/manifest.json", staged=True)
                sync_dir(staging)
                os.rename(staging, target)
                sync_dir(versions)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        # An idempotent retry of an older save must not roll back a newer desktop/web version.
        if previous is None or previous[0]["revision"] < manifest["revision"]:
            atomic(course / "current.json", encoded({"schema": 1, "course_id": course_id, "version_id": version_id,
                                                      "manifest": f"versions/{version_id}/manifest.json"}))
        return {"saved": True, "course": course_id, "version": version_id}


def default_root():
    workspace = config_dir() / "desktop-workspace.json"
    if workspace.is_file():
        state = read_json(workspace)
        if state.get("schema") != 1:
            raise ValueError("course2md 桌面工作区版本不受支持")
        selected = next((item for item in state.get("libraries", [])
                         if item.get("id") == state.get("default_library")), None)
        if state.get("default_library") and selected is None:
            raise ValueError("course2md 的保存位置不可用，请在桌面端重新选择")
        if selected:
            root = Path(selected["root"])
            if not root.is_absolute() or not root.is_dir():
                raise ValueError("course2md 的保存位置不可用，请在桌面端重新选择")
            return root.resolve()
    root = config_dir() / "desktop-local-library"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def publish_snapshot(payload):
    if not isinstance(payload, dict):
        raise ValueError("同步请求必须为 JSON 对象")
    validate_document(payload["document"])
    return publish(default_root(), payload)


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        raw = sys.stdin.buffer.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise ValueError("同步请求过大")
        print(json.dumps(publish_snapshot(json.loads(raw)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
