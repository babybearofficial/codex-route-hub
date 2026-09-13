from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field

from .controller import Controller, SyncResult
from .decide import Snapshot


@dataclass
class GraceTracker:
    seconds: float = 8.0
    started: float | None = None
    clock: Callable[[], float] = time.monotonic

    def in_grace(self, snapshot: Snapshot) -> bool:
        restarting = snapshot.webgpt_process and not snapshot.bridge_listening
        if not restarting:
            self.started = None
            return False
        now = self.clock()
        if self.started is None:
            self.started = now
        return (now - self.started) < self.seconds


@dataclass
class Watcher:
    controller: Controller
    interval: float = 2.0
    grace: GraceTracker = field(default_factory=GraceTracker)
    _stop: bool = False

    def tick(self) -> SyncResult:
        snapshot = self.controller.probe()
        return self.controller.sync(restart_grace=self.grace.in_grace(snapshot))

    def stop(self) -> None:
        self._stop = True

    def run(self, on_tick=None) -> None:
        self._stop = False
        while not self._stop:
            result = self.tick()
            if on_tick is not None:
                on_tick(result)
            time.sleep(self.interval)
