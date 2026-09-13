from __future__ import annotations

import threading
import queue
import time
import tkinter as tk
from tkinter import font as tkfont
from typing import Callable

from .controller import Controller, SyncResult
from .decide import Action, Snapshot
from .detect import route_url_from_toml
from .factory import Runtime, build_runtime
from .watch import GraceTracker

BG = "#121212"
CARD = "#1A1A1A"
BORDER = "#2A2A2A"
TEXT = "#F5F5F5"
MUTED = "#A1A1AA"
BLUE = "#3B82F6"
GREEN = "#22C55E"
ORANGE = "#F97316"
RED = "#EF4444"
BLUE_HOVER = "#2563EB"


def _state_color(on: bool) -> str:
    return GREEN if on else ORANGE


def _state_label(on: bool, yes: str, no: str) -> str:
    return yes if on else no


class StatusCard(tk.Frame):
    def __init__(self, master: tk.Misc, title: str) -> None:
        super().__init__(master, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        self.title = tk.Label(self, text=title, bg=CARD, fg=MUTED, anchor="w")
        self.title.pack(anchor="w", padx=14, pady=(12, 0))
        row = tk.Frame(self, bg=CARD)
        row.pack(fill="x", padx=14, pady=(6, 14))
        self.dot = tk.Label(row, text="●", bg=CARD, fg=MUTED)
        self.value = tk.Label(row, text="—", bg=CARD, fg=TEXT, anchor="w")
        self.dot.pack(side="left")
        self.value.pack(side="left", padx=(8, 0))

    def set_state(self, on: bool, text: str) -> None:
        color = _state_color(on)
        self.dot.configure(fg=color)
        self.value.configure(text=text, fg=TEXT)


class ActionButton(tk.Label):
    """A keyboard-accessible button whose colors also work on macOS Aqua."""
    def __init__(self, master, text, command, primary=False):
        bg = BLUE if primary else CARD
        super().__init__(master, text=text, bg=bg, fg=TEXT, takefocus=True,
                         highlightthickness=1, highlightbackground=BLUE if primary else BORDER,
                         cursor="hand2", padx=16, pady=10)
        self.command = command
        self.bind("<ButtonRelease-1>", lambda event: self.invoke())
        self.bind("<Return>", lambda event: self.invoke())
        self.bind("<space>", lambda event: self.invoke())
        self.bind("<Enter>", lambda event: self.configure(bg=BLUE_HOVER if primary else "#303030"))
        self.bind("<Leave>", lambda event: self.configure(bg=bg))
        self.bind("<FocusIn>", lambda event: self.configure(highlightbackground=BLUE))
        self.bind("<FocusOut>", lambda event: self.configure(highlightbackground=BLUE if primary else BORDER))

    def invoke(self):
        self.command()


class RoutingApp(tk.Tk):
    def __init__(self, runtime: Runtime) -> None:
        super().__init__()
        self.runtime = runtime
        self.grace = GraceTracker()
        self._busy = False
        self._pending = None
        self._closing = False
        self._events = queue.Queue(maxsize=128)
        self._refresh_id = None
        self._events_id = None
        self._worker = None
        runtime.controller.progress = lambda message: self._events.put(("progress", message))
        self._autosync = tk.BooleanVar(value=True)
        self.title("Codex 路由同步")
        self.configure(bg=BG)
        self.geometry("560x620")
        self.minsize(520, 560)
        self._setup_fonts()
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._on_window_close)
        try:
            self._paint(self.runtime.controller.probe())
        except Exception as exc:
            self._append_log(f"初始状态读取失败: {exc}")
        self._events_id = self.after(100, self._drain_events)
        self._refresh_id = self.after(1500, self._refresh_loop)

    def _setup_fonts(self) -> None:
        families = set(tkfont.families(self))
        heading = "PingFang SC" if "PingFang SC" in families else "Helvetica Neue"
        body = heading
        self.option_add("*Font", (body, 13))
        self.heading_font = tkfont.Font(family=heading, size=22, weight="bold")
        self.sub_font = tkfont.Font(family=body, size=13)
        self.card_title_font = tkfont.Font(family=body, size=12)
        self.card_value_font = tkfont.Font(family=body, size=16, weight="bold")
        self.log_font = tkfont.Font(family="Menlo", size=11)

    def _build(self) -> None:
        pad = tk.Frame(self, bg=BG)
        pad.pack(fill="both", expand=True, padx=24, pady=22)

        tk.Label(pad, text="Codex 路由同步", bg=BG, fg=TEXT, font=self.heading_font).pack(anchor="w")
        tk.Label(
            pad,
            text="开则接 17841，关则拆路由。关掉本窗口会拆掉死桥，避免 Codex 断网；窗口不会自动再开。不触碰 ChatGPT / Codex App。",
            bg=BG,
            fg=MUTED,
            font=self.sub_font,
            wraplength=500,
            justify="left",
        ).pack(anchor="w", pady=(6, 18))

        cards = tk.Frame(pad, bg=BG)
        cards.pack(fill="x")
        cards.columnconfigure((0, 1, 2), weight=1, uniform="cards")
        self.card_app = StatusCard(cards, "Codex Web GPT")
        self.card_bridge = StatusCard(cards, "本地桥")
        self.card_route = StatusCard(cards, "Codex 路由")
        for widget, col in ((self.card_app, 0), (self.card_bridge, 1), (self.card_route, 2)):
            widget.grid(row=0, column=col, sticky="nsew", padx=(0 if col == 0 else 8, 0))
            widget.title.configure(font=self.card_title_font)
            widget.value.configure(font=self.card_value_font)

        buttons = tk.Frame(pad, bg=BG)
        buttons.pack(fill="x", pady=(20, 8))
        ActionButton(buttons, "开启 Web GPT + 路由", self._on_enable, primary=True).pack(fill="x")
        ActionButton(buttons, "关闭 Web GPT + 路由", self._on_disable).pack(fill="x", pady=(8, 0))
        tk.Label(
            buttons,
            text="关闭只会退出 Codex Web GPT 及其 17841/隧道进程，ChatGPT 里的 Codex 继续跑。",
            bg=BG,
            fg=MUTED,
            wraplength=500,
            justify="left",
        ).pack(anchor="w", pady=(8, 0))

        row = tk.Frame(pad, bg=BG)
        row.pack(fill="x", pady=(8, 16))
        ActionButton(row, "立即同步", self._on_sync).pack(side="left")
        tk.Checkbutton(
            row,
            text="自动同步",
            variable=self._autosync,
            bg=BG,
            fg=TEXT,
            activebackground=BG,
            activeforeground=TEXT,
            selectcolor=CARD,
            highlightthickness=0,
            cursor="hand2",
        ).pack(side="left", padx=(16, 0))

        tk.Label(pad, text="日志", bg=BG, fg=MUTED, font=self.card_title_font).pack(anchor="w")
        self.log = tk.Text(
            pad,
            height=10,
            bg=CARD,
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
            highlightbackground=BORDER,
            highlightthickness=1,
            font=self.log_font,
            wrap="word",
            state="disabled",
        )
        self.log.pack(fill="both", expand=True, pady=(6, 0))
        self._append_log("就绪。自动同步已打开。开关不触碰 ChatGPT / Codex App。")

    def _append_log(self, message: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log.configure(state="normal")
        self.log.insert("end", f"[{stamp}] {message}\n")
        lines = int(self.log.index("end-1c").split(".")[0])
        if lines > 400:
            self.log.delete("1.0", f"{lines - 400 + 1}.0")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _paint(self, snap: Snapshot) -> None:
        self.card_app.set_state(snap.webgpt_process, _state_label(snap.webgpt_process, "运行中", "未运行"))
        self.card_bridge.set_state(
            snap.bridge_listening,
            (f"{self.runtime.config.port} 未就绪" if snap.runtime_ready is False else f"{self.runtime.config.port} 就绪") if snap.bridge_listening else f"{self.runtime.config.port} 断开",
        )
        url = route_url_from_toml(self.runtime.toml_path)
        self.card_route.set_state(snap.route_active, "已接入" if snap.route_active else "已断开")
        if snap.route_active and url:
            self.card_route.value.configure(text="已接入")

    def _refresh_loop(self) -> None:
        try:
            snap = self.runtime.controller.probe()
            self._paint(snap)
            if self._autosync.get() and not self._busy:
                self._run_bg(lambda: self.runtime.controller.sync(restart_grace=self.grace.in_grace(snap)))
        except Exception as exc:
            self._append_log(f"刷新失败: {exc}")
        self._refresh_id = self.after(1500, self._refresh_loop)

    def _run_bg(self, fn: Callable[[], SyncResult], announce: bool = False) -> None:
        if self._busy:
            if announce:
                self._pending = (fn, announce)
                self._append_log("操作已排队，将在当前步骤结束后执行。")
            return
        self._busy = True

        def worker() -> None:
            try:
                self._events.put(("result", (fn(), announce)))
            except Exception as exc:
                self._events.put(("error", str(exc)))

        self._worker = threading.Thread(target=worker, daemon=True, name="codex-routing-operation")
        self._worker.start()

    def _drain_events(self) -> None:
        # Only the Tk main thread may call Tk, including after().
        while True:
            try:
                kind, payload = self._events.get_nowait()
            except queue.Empty:
                break
            if kind == "progress":
                self._append_log(payload)
            elif kind == "result":
                self._finish(*payload)
            else:
                self._fail(payload)
        if not self._busy and self._pending:
            fn, announce = self._pending
            self._pending = None
            self._run_bg(fn, announce)
        elif not self._busy and self._closing:
            self.destroy()
            return
        self._events_id = self.after(100, self._drain_events)

    def _finish(self, result: SyncResult, announce: bool) -> None:
        self._busy = False
        self._worker = None
        if not result.ok:
            self._closing = False
        self._paint(result.snapshot)
        if result.detail:
            self._append_log(result.detail)
            return
        if result.action is Action.CONNECT:
            self._append_log("已接入路由：Codex → 127.0.0.1 桥。")
        elif result.action is Action.DISCONNECT:
            self._append_log("已断开路由：Codex 恢复开启前的连接配置。")
        elif announce:
            self._append_log("已经对齐，无需改路由。")

    def _fail(self, message: str) -> None:
        self._busy = False
        self._worker = None
        self._closing = False
        self._append_log(f"失败: {message}")

    def destroy(self) -> None:
        for callback in (self._refresh_id, self._events_id):
            if callback:
                try:
                    self.after_cancel(callback)
                except tk.TclError:
                    pass
        self.runtime.controller.progress = lambda message: None
        self._pending = None
        super().destroy()

    def _on_enable(self) -> None:
        self._append_log("正在开启 Codex Web GPT，并等待本地桥；校验运行时版本、归属和 Tunnel。")
        self._run_bg(self.runtime.controller.enable, announce=True)

    def _on_disable(self) -> None:
        self._append_log("正在断开路由并退出 Codex Web GPT，随后清理其 serve/隧道残留。")
        self._run_bg(self.runtime.controller.disable, announce=True)

    def _on_sync(self) -> None:
        snap = self.runtime.controller.probe()
        self._run_bg(
            lambda: self.runtime.controller.sync(restart_grace=self.grace.in_grace(snap)),
            announce=True,
        )

    def _on_window_close(self) -> None:
        self._autosync.set(False)
        self._closing = True
        self._run_bg(self.runtime.controller.disable, announce=True)


def close_manager(controller: Controller, destroy: Callable[[], None]) -> SyncResult:
    result = controller.disable()
    destroy()
    return result


def run_gui() -> None:
    runtime = build_runtime()
    app = RoutingApp(runtime)
    app.mainloop()
