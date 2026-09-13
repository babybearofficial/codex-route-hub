from __future__ import annotations

import socket
import subprocess
import time
from pathlib import Path

from .config_parse import parse_openai_base_url
from .decide import Snapshot
from .paths import (
    DEFAULT_APP_NAME,
    DEFAULT_BUNDLE_ID,
    DEFAULT_CODEX_TOML,
    DEFAULT_HOST,
    DEFAULT_PORT,
)
from .process import list_webgpt_app_pids


def is_port_open(host: str, port: int, timeout: float = 0.35) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect((host, port))
        except OSError:
            return False
    return True


def is_webgpt_process() -> bool:
    return bool(list_webgpt_app_pids())


def route_url_from_toml(path: Path = DEFAULT_CODEX_TOML) -> str | None:
    if not path.is_file():
        return None
    return parse_openai_base_url(path.read_text())


def collect_snapshot(
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    toml_path: Path = DEFAULT_CODEX_TOML,
    home: Path | None = None,
) -> Snapshot:
    ready = None
    if home is not None:
        import json
        import os
        try:
            config = json.loads((home / "config.json").read_text())
            if config.get("browserHost") == "launcher":
                ready = False
                owner = json.loads((home / "runtime/launcher-supervisor.json").read_text())
                if owner.get("status") == "ready":
                    os.kill(owner["ownerPid"], 0)
                    os.kill(owner["daemonPid"], 0)
                    ready = True
        except (OSError, ValueError, KeyError, TypeError):
            ready = False
    return Snapshot(
        runtime_ready=ready,
        webgpt_process=is_webgpt_process(),
        bridge_listening=is_port_open(host, port),
        route_active=(route_url_from_toml(toml_path) or "").rstrip("/") == f"http://{host}:{port}/v1",
    )


def wait_for_bridge(
    host: str,
    port: int,
    timeout: float,
    interval: float = 0.4,
) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_port_open(host, port):
            return True
        time.sleep(interval)
    return False


def start_app_argv(bundle_id: str = DEFAULT_BUNDLE_ID) -> list[str]:
    return ["open", "-g", "-b", bundle_id]


def stop_app_argv(bundle_id: str = DEFAULT_BUNDLE_ID) -> list[str]:
    return ["osascript", "-e", f'tell application id "{bundle_id}" to quit']


def start_webgpt_app(
    name: str = DEFAULT_APP_NAME,
    bundle_id: str = DEFAULT_BUNDLE_ID,
) -> None:
    del name
    subprocess.run(start_app_argv(bundle_id), check=True, timeout=15)


def stop_webgpt_app(
    name: str = DEFAULT_APP_NAME,
    bundle_id: str = DEFAULT_BUNDLE_ID,
) -> None:
    del name
    try:
        subprocess.run(stop_app_argv(bundle_id), check=False, capture_output=True,
                       text=True, timeout=5)
    except subprocess.TimeoutExpired:
        # Process ownership-checked shutdown follows this best-effort GUI quit.
        pass


def wait_for_runtime(home: Path, host: str, port: int, timeout: float) -> bool:
    """Wait for launcher readiness, not just the first listening daemon socket."""
    import json
    import os
    import urllib.request
    config = json.loads((home / "config.json").read_text())
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if config.get("browserHost") == "launcher":
                marker = home / "runtime/launcher-supervisor.json"
                if marker.exists():
                    state = json.loads(marker.read_text())
                    if state.get("status") in {"failed", "needs-setup"}:
                        return False
            with opener.open(f"http://{host}:{port}/healthz", timeout=1) as response:
                health = json.load(response)
            healthy = (health.get("service") == "codex-chatgpt-web"
                       and health.get("status") == "ok"
                       and health.get("version") == config.get("releaseVersion")
                       and health.get("mode") == config.get("mode")
                       and health.get("accepting_turns") is True)
            if config.get("browserHost") == "launcher":
                owner = json.loads((home / "runtime/launcher-supervisor.json").read_text())
                os.kill(owner["ownerPid"], 0)
                healthy = healthy and owner.get("status") == "ready" and owner.get("daemonPid") == health.get("pid")
            if healthy:
                return True
        except (OSError, ValueError, KeyError, TypeError):
            pass
        time.sleep(0.4)
    return False
