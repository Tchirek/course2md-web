"""course2md schema-1 library bridge. Stdlib only; never edits desktop workspace state."""
import base64
import contextlib
import hashlib
import json
import math
import mimetypes
import os
import platform
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

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
        return Path(explicit)
    if os.environ.get("XDG_CONFIG_HOME"):
        return Path(os.environ["XDG_CONFIG_HOME"]) / "course2md"
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "course2md"
    return Path.home() / ".config" / "course2md"


def libraries(data_dir):
    roots = []
    warnings = []
    preferred = ""
    workspace = config_dir() / "desktop-workspace.json"
    if workspace.is_file():
        try:
            state = read_json(workspace)
            if state.get("schema") != 1:
                raise ValueError("course2md 桌面工作区版本不受支持")
            roots.extend({"root": x["root"], "name": x.get("name", "课程库")} for x in state.get("libraries", []))
            preferred = next((x["root"] for x in state.get("libraries", []) if x.get("id") == state.get("default_library")), "")
        except (ValueError, KeyError, OSError) as error:
            warnings.append(f"无法读取课程库记录：{error}")
    own = data_dir / "libraries.json"
    if own.exists():
        roots.extend(read_json(own))
    default = config_dir() / "desktop-local-library"
    if not any(Path(x["root"]).is_absolute() and Path(x["root"]).is_dir() for x in roots):
        try:
            default.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            warnings.append(f"无法准备默认课程库：{error}")
    if default.is_dir():
        roots.append({"root": str(default), "name": "本地课程库"})
    found = {}
    for item in roots:
        root = Path(item["root"])
        if not root.is_absolute():
            warnings.append("已忽略相对路径课程库")
            continue
        key = digest(os.fsencode(str(root.resolve())))[:32]
        found.setdefault(key, {"id": key, "name": item["name"], "root": str(root.resolve()), "available": root.is_dir()})
    available = [x for x in found.values() if x["available"]]
    selected = next((x for x in available if preferred and Path(x["root"]) == Path(preferred).resolve()), None)
    selected = selected or (available[0] if available else None)
    return {"libraries": list(found.values()), "defaultLibrary": selected["id"] if selected else "", "warnings": warnings}


def root_for(data_dir, identifier):
    for item in libraries(data_dir)["libraries"]:
        if item["id"] == identifier and item["available"]:
            return Path(item["root"])
    raise ValueError("课程库未连接或保存位置不可用")


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


def readable_current(course, verify=True):
    try:
        return (*current(course, verify), "")
    except (OSError, ValueError, KeyError, TypeError) as error:
        candidates = []
        versions = safe(course, "versions")
        if versions.is_dir():
            for child in versions.iterdir():
                if child.is_dir() and not child.name.startswith("."):
                    try:
                        item = version(course, f"versions/{child.name}/manifest.json", verify)
                        candidates.append(item)
                    except (OSError, ValueError, KeyError, TypeError):
                        pass
        if not candidates:
            raise ValueError(f"课程没有可用版本：{error}") from error
        selected = max(candidates, key=lambda item: (item[0]["revision"], item[0]["created_at_ms"]))
        return (*selected, f"当前版本不可用，正在读取可用历史版本：{error}")


def list_courses(root):
    courses, warnings = [], []
    aliases, folders = {}, {}
    for name in (".course2md-titles.json", ".course2md-library.json"):
        try:
            if (root / name).exists():
                value = read_json(root / name)
                if not isinstance(value, dict):
                    raise ValueError("分类记录不是对象")
                if "titles" in name:
                    aliases = value.get("names", {})
                else:
                    folders = {key.replace("\\", "/"): value.get("folders", {}).get(str(identifier), "") for key, identifier in value.get("courses", {}).items()}
        except (OSError, ValueError, TypeError, AttributeError) as error:
            warnings.append(f"无法读取分类记录：{error}")
    aliases = {key.replace("\\", "/"): value for key, value in aliases.items()}
    # ponytail: bounded scan, no database; add an index only when real libraries exceed 5,000 directories.
    pending, visited = [(root, 0)], 0
    while pending and visited < 5000:
        directory, depth = pending.pop()
        visited += 1
        if (directory / "current.json").is_file():
            key = directory.relative_to(root).as_posix()
            try:
                manifest, document, _, warning = readable_current(directory, verify=False)
                if warning:
                    warnings.append(f"{key}：{warning}")
                courses.append({"course": key, "title": aliases.get(key, manifest["title"]), "folder": folders.get(key, ""),
                                "version": manifest["version_id"], "sourceId": manifest["source_id"],
                                "url": document["meta"]["webpage_url"], "duration": document["meta"]["duration"],
                                "created": manifest["created_at_ms"], "partial": manifest["partial"]})
            except (OSError, ValueError, KeyError, TypeError) as error:
                warnings.append(f"{key}：{error}")
            continue
        if depth < 8:
            try:
                for child in directory.iterdir():
                    if child.is_dir() and not child.name.startswith(".") and child.name != "versions" and not child.is_symlink() and not getattr(child, "is_junction", lambda: False)():
                        pending.append((child, depth + 1))
            except OSError as error:
                warnings.append(f"{directory.name}：{error}")
    if pending:
        warnings.append("课程库超过单次扫描范围，请连接更具体的目录")
    courses.sort(key=lambda item: item["created"], reverse=True)
    return {"courses": courses, "warnings": warnings}


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
        return {"saved": True, "course": course_id, "version": version_id, "library": payload["library"]}


def engine(data_dir, requested=None):
    config = data_dir / "upstream-engine.json"
    saved = read_json(config).get("path") if config.is_file() else None
    executable = "course2md.exe" if os.name == "nt" else "course2md"
    on_path = shutil.which("course2md")
    folders = [data_dir / "bin", Path.home() / "bin", Path.home() / ".local/bin", Path.home() / ".cargo/bin"]
    if os.environ.get("COURSE2MD_BIN_DIR"):
        folders.insert(0, Path(os.environ["COURSE2MD_BIN_DIR"]))
    if on_path:
        folders.insert(0, Path(on_path).parent)
    if os.name == "nt":
        folders += [Path(os.environ.get(key, str(Path.home()))) / suffix for key, suffix in
                    (("LOCALAPPDATA", "Programs/course2md"), ("ProgramFiles", "course2md"))]
        # Portable desktop installs have no fixed location; use the running app's sibling engine.
        try:
            paths = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                "Get-Process -Name course2md-desktop -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"],
                capture_output=True, timeout=5).stdout.decode("utf-8", errors="replace").splitlines()
            folders += [Path(p).parent for p in paths if Path(p).is_absolute()]
        except (OSError, subprocess.TimeoutExpired):
            pass
    elif sys.platform == "darwin":
        folders += [Path("/Applications/course2md.app/Contents/MacOS"), Path.home() / "Applications/course2md.app/Contents/MacOS",
                    Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
    candidates = [requested] if requested else [saved, os.environ.get("C2MD_CLI"), on_path, *(str(p / executable) for p in folders)]
    for candidate in dict.fromkeys(candidates):
        if not candidate:
            continue
        file = Path(candidate)
        if not file.is_absolute() or not file.is_file() or (os.name == "nt" and file.suffix.lower() != ".exe"):
            if requested:
                raise ValueError("请输入 course2md CLI 可执行文件的绝对路径")
            continue
        try:
            result = subprocess.run([str(file), "--version"], capture_output=True, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            if requested:
                raise ValueError("无法运行所选 CLI")
            continue
        label = result.stdout.decode("utf-8", errors="replace").strip()
        if result.returncode == 0 and re.fullmatch(r"course2md 2\.\d+\.\d+[^\r\n]*", label):
            if requested:
                atomic(config, encoded({"path": str(file)}))
            return {"available": True, "path": str(file), "version": label[:160], "message": ""}
        if requested:
            raise ValueError("需要 course2md 2.0 CLI；" + label[:160])
    return {"available": False, "path": "", "version": "", "message": "未找到可用的 CLI。导出时可自动安装，也可以连接已有程序。"}


def install_engine(data_dir):
    existing = engine(data_dir)
    if existing["available"]:
        return existing
    machine = platform.machine().lower()
    arch = "aarch64" if machine in ("arm64", "aarch64") else "x86_64" if machine in ("amd64", "x86_64") else ""
    system = "windows" if os.name == "nt" else "macos" if sys.platform == "darwin" else "linux" if sys.platform == "linux" else ""
    key = f"{system}-{arch}"
    pins = read_json(Path(__file__).with_name("engine-pins.json"))
    if key not in pins["assets"]:
        raise ValueError("此系统暂不提供自动安装，请连接已有 CLI")
    asset = pins["assets"][key]
    directory = data_dir / "bin"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ("course2md.exe" if os.name == "nt" else "course2md")
    with file_lock(directory / ".engine-install.lock"):
        existing = engine(data_dir)
        if existing["available"]:
            return existing
        url = f"https://github.com/mizorewww/course2md/releases/download/{pins['version']}/{asset['name']}"
        fd, temporary = tempfile.mkstemp(prefix=".course2md-", suffix=target.suffix, dir=directory)
        try:
            with os.fdopen(fd, "wb") as output, urlopen(url, timeout=30) as response:
                remaining = asset["bytes"]
                while remaining:
                    chunk = response.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("CLI 下载不完整，请重试")
                    output.write(chunk)
                    remaining -= len(chunk)
                if response.read(1):
                    raise ValueError("CLI 下载大小不符")
            file = Path(temporary)
            if digest(file.read_bytes()) != asset["sha256"]:
                raise ValueError("CLI 校验失败，未安装")
            file.chmod(0o755)
            # Validate before replacing the managed copy; never change a desktop installation.
            check = subprocess.run([str(file), "--version"], capture_output=True, timeout=5)
            if check.returncode or not re.fullmatch(r"course2md 2\.\d+\.\d+[^\r\n]*", check.stdout.decode("utf-8", errors="replace").strip()):
                raise ValueError("下载的 CLI 未通过运行检查")
            os.replace(file, target)
            return engine(data_dir, str(target))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def export_with_engine(data_dir, root, payload):
    tool = engine(data_dir)
    if not tool["available"]:
        raise ValueError(tool["message"])
    format_name = payload.get("format", "md")
    if format_name not in ("md", "html", "json"):
        raise ValueError("请选择 Markdown、HTML 或 JSON 导出格式")
    course = safe(root, payload["course"])
    manifest, document, directory = version(course, f"versions/{payload['version']}/manifest.json")
    task = "web-export-" + uuid.uuid4().hex
    expected = safe(course, f"exports/{manifest['version_id']}/{task}")
    work = Path(tempfile.mkdtemp(prefix="web-export-", dir=data_dir))
    try:
        request = {"schema": 1, "operation": {"kind": "reprocess", "base_version_dir": str(directory), "components": ["exports"]},
                   "task_id": task, "course_id": manifest["course_id"], "version_id": task,
                   "source": document["meta"]["webpage_url"], "source_id": manifest["source_id"], "title": document["meta"]["title"],
                   "author": document["meta"]["uploader"], "duration": document["meta"]["duration"],
                   "config": {"defaults": {"formats": [format_name]}}, "work_dir": str(work), "course_dir": str(course)}
        # Export-only run-task neither downloads media nor starts ASR/LLM; the engine owns portable formats.
        result = subprocess.run([tool["path"], "run-task"], input=encoded(request), capture_output=True, timeout=50)
        done = None
        error_message = ""
        for line in result.stdout.splitlines():
            event = json.loads(line)
            if event.get("type") == "done":
                done = event
            if event.get("type") == "error":
                error_message = event.get("message", "")
        if result.returncode or not done or done.get("partial"):
            if done:
                error_message = done.get("outcomes", {}).get("exports", {}).get(format_name, {}).get("message", "")
            raise ValueError("图文导出未完成；课程笔记保持可用。" + (error_message or result.stderr.decode("utf-8", errors="replace")[-500:]))
        outputs = []
        for output in done["outputs"]:
            file = Path(output).resolve()
            if not file.is_relative_to(expected) or not file.is_file():
                raise ValueError("CLI 返回了无效的导出位置")
            outputs.append(str(file))
        if not outputs:
            raise ValueError("未生成导出文件")
        return {"outputs": outputs, "version": manifest["version_id"]}
    finally:
        shutil.rmtree(work)


def handle(action, payload, data_dir):
    if action == "discover":
        return libraries(data_dir)
    if action == "connect":
        root = Path(payload["root"])
        if not root.is_absolute() or not root.is_dir():
            raise ValueError("请输入已存在的课程库绝对路径")
        root = root.resolve()
        records = read_json(data_dir / "libraries.json") if (data_dir / "libraries.json").exists() else []
        records = [record for record in records if Path(record["root"]).resolve() != root]
        records.append({"root": str(root), "name": root.name})
        atomic(data_dir / "libraries.json", encoded(records))
        return libraries(data_dir)
    if action == "engine":
        return install_engine(data_dir) if payload.get("install") is True else engine(data_dir, payload.get("path"))
    root = root_for(data_dir, payload["library"])
    if action == "list":
        return list_courses(root)
    if action == "publish":
        return publish(root, payload)
    if action == "export":
        return export_with_engine(data_dir, root, payload)
    course = safe(root, payload["course"])
    if action in ("read", "image"):
        warning = ""
        if payload.get("version"):
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", payload["version"]) or payload["version"] in (".", ".."):
                raise ValueError("无效的课程版本")
            manifest, document, directory = version(course, f"versions/{payload['version']}/manifest.json", verify=action != "image")
        else:
            manifest, document, directory, warning = readable_current(course, verify=action != "image")
        if action == "image":
            image = payload["image"]
            if image not in {f["image"] for f in manifest["frames"]}:
                raise ValueError("图片未列入课程清单")
            file = safe(directory, image)
            mime = mimetypes.guess_type(file)[0]
            if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif") or file.stat().st_size > 8 * 1024 * 1024:
                raise ValueError("图片格式或大小不受支持")
            data = file.read_bytes()
            asset = next((a for a in manifest["assets"] if a["path"] == image), None)
            if not asset or len(data) != asset["bytes"] or digest(data) != asset["sha256"]:
                raise ValueError("课程画面已更改或损坏")
            return {"data": f"data:{mime};base64," + base64.b64encode(data).decode()}
        web = read_json(safe(directory, "web-document.json")) if any(a["path"] == "web-document.json" for a in manifest["assets"]) else None
        available = []
        for child in (course / "versions").iterdir():
            if child.is_dir() and not child.name.startswith("."):
                try:
                    item = read_json(safe(child, "manifest.json"))
                    available.append({"id": item["version_id"], "created": item["created_at_ms"], "revision": item["revision"]})
                except (OSError, ValueError, KeyError):
                    pass
        return {"manifest": manifest, "document": document, "web": web, "warnings": [warning] if warning else [], "versions": sorted(available, key=lambda x: x["revision"], reverse=True)}
    raise ValueError("未知的课程库操作")


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        raw = sys.stdin.buffer.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise ValueError("课程保存请求过大")
        request = json.loads(raw)
        print(json.dumps(handle(request["action"], request["payload"], Path(os.environ["C2MD_DATA_DIR"])), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
