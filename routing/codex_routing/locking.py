"""Serialize GUI, CLI and watcher mutations; release descriptors after every operation."""
from __future__ import annotations

import fcntl
import os
import threading
import time
from functools import wraps
from pathlib import Path


class OperationLock:
    def __init__(self, path: Path):
        self.path = path
        self.local = threading.RLock()
        self.depth = 0
        self.fd = None

    def __enter__(self):
        self.local.acquire()
        try:
            if self.depth == 0:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
                deadline = time.monotonic() + 300
                while True:
                    try:
                        fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Another routing operation is still running")
                        time.sleep(.1)
            self.depth += 1
            return self
        except BaseException:
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            self.local.release()
            raise

    def __exit__(self, *exc):
        self.depth -= 1
        if self.depth == 0 and self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.local.release()


def serialized(fn):
    @wraps(fn)
    def call(self, *args, **kwargs):
        with self.operation_lock:
            return fn(self, *args, **kwargs)
    return call
