"""本機サービス（文字起こし・整形）共通の寿命管理。

- IdleWatch：仕事がないまま一定時間（既定 10 分）経ったらサーバーを止める。モデルは
  数 GB のメモリを確保し続けるので、使っていない間は手放し、次に使うときMizoreLinkが起動し直す。
- popen_bound：子プロセスをこのプロセスの寿命に縛って起動する。親が強制終了されても
  子（llama-server など）が数 GB を抱えたまま居残らないようにする。
"""
import os
import atexit
import signal
import subprocess
import sys
import threading
import time

IDLE_SECONDS = float(os.environ.get("C2MD_IDLE_SECONDS", "600"))


class IdleWatch:
    """仕事（POST 要求）の出入りを数え、仕事がないまま IDLE_SECONDS 経ったら on_idle を一度呼ぶ。

    /health などの問い合わせは数えない。状態確認のたびに寿命が延び、永遠に居座るため。
    """

    def __init__(self, on_idle):
        self.on_idle = on_idle
        self.lock = threading.Lock()
        self.busy = 0
        self.last = time.monotonic()
        threading.Thread(target=self._run, daemon=True).start()

    def __enter__(self):
        with self.lock:
            self.busy += 1
        return self

    def __exit__(self, *_exc):
        with self.lock:
            self.busy -= 1
            self.last = time.monotonic()
        return False

    def _run(self):
        while True:
            time.sleep(max(0.2, min(30.0, IDLE_SECONDS / 10)))
            with self.lock:
                idle = self.busy == 0 and time.monotonic() - self.last >= IDLE_SECONDS
            if idle:
                self.on_idle()
                return


def memory_hint():
    """How much memory the system can still hand out (RAM plus page file), for out-of-memory messages.

    A model that fails to load for lack of memory looks like a crash or a cryptic assertion
    (MKL, ggml, CUDA each word it differently). The number tells the user what to do about it.
    """
    try:
        if sys.platform == "win32":
            import ctypes

            class Status(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                            ("total_phys", ctypes.c_ulonglong), ("avail_phys", ctypes.c_ulonglong),
                            ("total_page", ctypes.c_ulonglong), ("avail_page", ctypes.c_ulonglong),
                            ("total_virtual", ctypes.c_ulonglong), ("avail_virtual", ctypes.c_ulonglong),
                            ("avail_extended", ctypes.c_ulonglong)]

            status = Status()
            status.length = ctypes.sizeof(Status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return f"系统当前可用内存（含虚拟内存）约 {status.avail_page / 2**30:.1f} GB；请关闭一些程序，或在系统设置里增大虚拟内存"
        else:
            available = os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
            return f"系统当前可用内存约 {available / 2**30:.1f} GB；请关闭一些程序后重试"
    except Exception:
        pass
    return "请关闭一些程序，或增大虚拟内存后重试"


def idle_message(what):
    span = f"{IDLE_SECONDS / 60:g} 分钟" if IDLE_SECONDS >= 60 else f"{IDLE_SECONDS:g} 秒"
    return f"{span}未使用，已释放{what}；下次使用时会自动重新加载"


_jobs = []


def popen_bound(args, **options):
    """子プロセスをこのプロセスの寿命に縛って起動する。options は Popen にそのまま渡す。"""
    if sys.platform.startswith("linux"):
        return subprocess.Popen(args, preexec_fn=_die_with_parent, **options)
    process = subprocess.Popen(args, **options)
    if sys.platform == 'darwin':
        # pkill sends SIGTERM. Unwind Python finally blocks so owned model children exit too.
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        atexit.register(lambda: process.terminate() if process.poll() is None else None)
    if sys.platform == "win32":
        try:
            _kill_on_close(process)
        except OSError as error:
            # 縛れなくても起動は続ける（通常の終了経路では terminate で止まる）
            print(f"无法把子进程绑定到本进程：{error}", file=sys.stderr, flush=True)
    return process


def _die_with_parent():
    import ctypes
    import signal
    ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG


def _kill_on_close(process):
    """Windows：子を KILL_ON_JOB_CLOSE のジョブに入れる。ジョブのハンドルは閉じずに持ち続け、
    このプロセスが終わる（強制終了を含む）と OS がハンドルを閉じて子も終わる。"""
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class Extended(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    info = Extended()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):  # 9 = ExtendedLimitInformation
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel32.AssignProcessToJobObject(job, int(process._handle)):
        raise ctypes.WinError(ctypes.get_last_error())
    _jobs.append(job)
