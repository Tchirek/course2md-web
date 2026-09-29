"""运行时下载物的固定版本与校验。

所有在用户机器上下载后执行或加载的东西（模型、运行库、源码）都在 runtime-pins.json 里
写死版本（提交号、发布标签）和 SHA-256。下载后先校验再使用，同一个版本的本项目在任何
时候安装，跑的都是同一份东西；上游被篡改或传输出错会被拒收，而不是直接执行。
"""
import hashlib
import json
from pathlib import Path

PINS = json.loads(Path(__file__).with_name("runtime-pins.json").read_text(encoding="utf-8"))


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class VerifiedFiles:
    """记住已校验过的文件（按大小与修改时间），几 GB 的模型不必每次启动都重新算哈希。"""

    def __init__(self, record):
        self.record = Path(record)
        try:
            self.seen = json.loads(self.record.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.seen = {}

    def matches(self, path, expected):
        path = Path(path)
        if not path.is_file():
            return False
        stat = path.stat()
        key = str(path.resolve())
        stamp = [stat.st_size, stat.st_mtime_ns, expected]
        if self.seen.get(key) == stamp:
            return True
        if sha256_of(path) != expected:
            return False
        self.seen[key] = stamp
        self.record.parent.mkdir(parents=True, exist_ok=True)
        self.record.write_text(json.dumps(self.seen), encoding="utf-8")
        return True
