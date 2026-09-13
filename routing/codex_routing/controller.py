from __future__ import annotations

from dataclasses import dataclass
import threading

from .locking import serialized
from typing import Callable, Protocol

from .decide import Action, Snapshot, decide_route_action
from .intent import FileIntent, MemoryIntent


class RoutePort(Protocol):
    def connect(self) -> dict: ...
    def disconnect(self) -> dict: ...


class AppPort(Protocol):
    def start(self) -> None: ...
    def stop(self) -> None: ...
    def ensure_runtime(self) -> None: ...
    def stop_runtime(self) -> None: ...


@dataclass(frozen=True)
class SyncResult:
    action: Action
    snapshot: Snapshot
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.detail == "" or self.detail.startswith("aligned")


class Controller:
    def __init__(
        self,
        probe: Callable[[], Snapshot],
        route: RoutePort,
        app: AppPort,
        wait_bridge: Callable[[float], bool] | None = None,
        intent: MemoryIntent | FileIntent | None = None,
    ) -> None:
        self.probe = probe
        self.route = route
        self.app = app
        self.wait_bridge = wait_bridge
        self.intent = intent or MemoryIntent()
        self.progress = lambda message: None
        self.operation_lock = threading.RLock()

    @serialized
    def sync(self, *, restart_grace: bool = False) -> SyncResult:
        snapshot = self.probe()
        action = decide_route_action(
            snapshot,
            restart_grace=restart_grace,
            user_off=self.intent.is_off(),
        )
        if action is Action.CONNECT:
            self.route.connect()
            verify = getattr(self.route, "verify", None)
            detail = verify() if verify else ""
            if detail:
                self.route.disconnect()
                return SyncResult(action=Action.DISCONNECT, snapshot=self.probe(), detail=detail)
        elif action is Action.DISCONNECT:
            self.route.disconnect()
            if not snapshot.webgpt_process or self.intent.is_off():
                self.app.stop_runtime()
        return SyncResult(action=action, snapshot=self.probe())

    @serialized
    def enable(self, timeout: float = 90.0, gui_timeout: float = 12.0) -> SyncResult:
        self.intent.mark_on()
        try:
            restore = getattr(self.route, "restore_checkpoint", None)
            if restore:
                restore()
            self.progress("1/4 正在后台启动 Codex Web GPT…")
            self.app.start()
            self.progress("2/4 正在核对版本并配置模型连接（最长约 3 分钟）…")
            prepare = getattr(self.route, "prepare", None)
            changed = prepare() if prepare else False
            if changed:
                self.app.ensure_runtime()
            self.progress("3/4 正在等待启动器接管代理和 Tunnel…")
            waiter = self.wait_bridge
            if waiter is not None:
                first = timeout if changed else min(gui_timeout, timeout)
                if not waiter(first):
                    self.app.ensure_runtime()
                    if not waiter(timeout):
                        raise RuntimeError("bridge timeout: runtime did not become ready")
            # Verify even if the route/port was already active when On was clicked.
            self.progress("4/4 正在验证代理归属、浏览器登录和 Tunnel…")
            self.route.connect()
            verify = getattr(self.route, "verify", None)
            detail = verify() if verify else ""
            if detail:
                self.app.ensure_runtime()
                if waiter is not None:
                    waiter(max(timeout - gui_timeout, 1.0))
                detail = verify()
            if detail:
                raise RuntimeError(detail)
            snapshot = self.probe()
            if not snapshot.webgpt_healthy or not snapshot.route_active:
                raise RuntimeError("Runtime or route did not remain active after startup")
            return SyncResult(action=Action.CONNECT, snapshot=snapshot)
        except Exception as exc:
            # Restore the prior connection instead of leaving Codex on a failed bridge.
            cleanup = self.disable()
            detail = f"enable failed: {exc}"
            if cleanup.detail:
                detail += f"; {cleanup.detail}"
            return SyncResult(action=Action.NONE, snapshot=cleanup.snapshot, detail=detail)

    @serialized
    def disable(self) -> SyncResult:
        self.progress("正在关闭 Web GPT 并恢复开启前配置…")
        self.intent.mark_off()
        errors = []
        # Stop the writer/supervisor before restoring config; otherwise it can reconnect.
        for label, operation in (("app stop", self.app.stop),
                                 ("runtime stop", self.app.stop_runtime),
                                 ("route disconnect", self.route.disconnect)):
            try:
                operation()
            except Exception as exc:
                errors.append(f"{label} failed: {exc}")
        snapshot = self.probe()
        if snapshot.route_active:
            errors.append("Web GPT route remains active")
        if snapshot.webgpt_process:
            errors.append("Web GPT process remains running")
        if not errors:
            finish = getattr(self.route, "finish_off", None)
            if finish:
                try:
                    finish()
                except Exception as exc:
                    errors.append(f"journal retirement failed: {exc}")
        return SyncResult(action=Action.DISCONNECT, snapshot=snapshot, detail="; ".join(errors))
