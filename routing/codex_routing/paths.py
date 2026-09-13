from __future__ import annotations

import json
import os
import plistlib
from dataclasses import dataclass
from pathlib import Path


DEFAULT_HOME = Path(os.environ.get("CODEX_CHATGPT_WEB_HOME", Path.home() / ".codex-chatgpt-web"))
DEFAULT_CODEX_TOML = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "config.toml"
DEFAULT_APP_NAME = "Codex Web GPT"
DEFAULT_BUNDLE_ID = "dev.codexwebgpt.launcher"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 17841


@dataclass(frozen=True)
class WebGptConfig:
    host: str
    port: int


def _version_key(name: str) -> tuple[int, ...]:
    head = name.split("-", 1)[0]
    parts: list[int] = []
    for part in head.split("."):
        parts.append(int(part) if part.isdigit() else 0)
    return tuple(parts)


def _cli_from_config(home: Path) -> tuple[Path, Path] | None:
    config_path = home / "config.json"
    if not config_path.is_file():
        return None
    try:
        loaded = json.loads(config_path.read_text())
    except json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict):
        return None
    cmd = loaded.get("runtimeCommand")
    if not isinstance(cmd, list) or len(cmd) < 2:
        return None
    bun = Path(str(cmd[0]))
    cli = Path(str(cmd[1]))
    if bun.is_file() and cli.is_file():
        return bun, cli
    return None


def _newest_cli(home: Path) -> tuple[Path, Path]:
    versions = home / "versions"
    candidates: list[tuple[tuple[int, ...], Path, Path]] = []
    if versions.is_dir():
        for folder in versions.iterdir():
            bun = folder / "runtime" / "bun"
            cli = folder / "app" / "cli.js"
            if bun.is_file() and cli.is_file():
                candidates.append((_version_key(folder.name), bun, cli))
    if not candidates:
        raise FileNotFoundError(f"No Codex Web GPT CLI under {versions}")
    candidates.sort()
    _, bun, cli = candidates[-1]
    return bun, cli


def locate_cli(home: Path) -> tuple[Path, Path]:
    pinned = _cli_from_config(home)
    if pinned is not None:
        return pinned
    return _newest_cli(home)


def locate_route_cli(home: Path) -> tuple[Path, Path]:
    return _newest_cli(home)


def read_webgpt_config(path: Path) -> WebGptConfig:
    data: dict = {}
    if path.is_file():
        loaded = json.loads(path.read_text())
        if isinstance(loaded, dict):
            data = loaded
    host = data.get("host") or DEFAULT_HOST
    port = data.get("port") or DEFAULT_PORT
    return WebGptConfig(host=str(host), port=int(port))


def read_bridge_port(path: Path) -> int:
    return read_webgpt_config(path).port


def locate_launcher_cli(home: Path) -> tuple[Path, Path]:
    """Match the installed launcher, not a newer downloaded/staged version."""
    info = Path("/Applications/Codex Web GPT.app/Contents/Info.plist")
    if info.exists():
        with info.open("rb") as stream:
            version = plistlib.load(stream)["CFBundleShortVersionString"]
        import platform
        arch = "arm64" if platform.machine() == "arm64" else "x64"
        root = home / "versions" / f"{version}-darwin-{arch}"
        bun, cli = root / "runtime" / "bun", root / "app" / "cli.js"
        if bun.is_file() and cli.is_file():
            return bun, cli
        raise FileNotFoundError(f"Launcher runtime {version} is not installed under {home}")
    return locate_route_cli(home)
