from __future__ import annotations

import os
import signal
import subprocess
from collections.abc import Callable, Iterable

PROTECTED_MARKERS = (
    "/Applications/ChatGPT.app",
    "Codex Framework.framework",
    "com.openai.codex",
    "/Codex Computer Use.app/",
    "/.codex/computer-use/",
)

WEB_GPT_MARKERS = (
    "/Applications/Codex Web GPT.app",
    "/.codex-chatgpt-web/",
    "dev.codexwebgpt.launcher",
)


def is_protected_command(command: str) -> bool:
    return any(marker in command for marker in PROTECTED_MARKERS)


def _executable(command: str) -> str:
    stripped = command.lstrip()
    if not stripped:
        return ""
    return stripped.split(None, 1)[0]


def is_webgpt_app_command(command: str) -> bool:
    if is_protected_command(command):
        return False
    return command.lstrip().startswith("/Applications/Codex Web GPT.app")


def is_webgpt_command(command: str) -> bool:
    if is_protected_command(command):
        return False
    stripped = command.lstrip()
    if is_webgpt_app_command(stripped):
        return True
    exe = _executable(stripped)
    return "/.codex-chatgpt-web/" in exe


def is_webgpt_runtime_command(command: str) -> bool:
    if not is_webgpt_command(command):
        return False
    if is_webgpt_app_command(command):
        return True
    # Administrative CLI operations must never be killed during cleanup.
    import shlex
    try:
        argv = shlex.split(command)
    except ValueError:
        return False
    if len(argv) >= 3 and argv[1].endswith("/cli.js"):
        return argv[2] in {"serve", "mcp"}
    if "tunnel-client" in argv[0]:
        return len(argv) > 1 and argv[1] in {"run", "connect"}
    return False


def parse_ps_line(line: str) -> tuple[int, str] | None:
    stripped = line.strip()
    if not stripped:
        return None
    pid_s, sep, cmd = stripped.partition(" ")
    if not sep or not pid_s.isdigit():
        return None
    return int(pid_s), cmd.lstrip()


def webgpt_pids(ps_output: str) -> tuple[int, ...]:
    found: list[int] = []
    for line in ps_output.splitlines():
        parsed = parse_ps_line(line)
        if parsed is None:
            continue
        pid, cmd = parsed
        if is_webgpt_runtime_command(cmd):
            found.append(pid)
    return tuple(found)


def list_webgpt_pids(run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> tuple[int, ...]:
    result = run(
        ["ps", "-ax", "-o", "pid=,command="],
        capture_output=True,
        text=True,
        check=False,
    )
    return webgpt_pids(result.stdout or "")


def webgpt_app_pids(ps_output: str) -> tuple[int, ...]:
    found: list[int] = []
    for line in ps_output.splitlines():
        parsed = parse_ps_line(line)
        if parsed is None:
            continue
        pid, cmd = parsed
        if is_webgpt_app_command(cmd):
            found.append(pid)
    return tuple(found)


def list_webgpt_app_pids(run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> tuple[int, ...]:
    result = run(
        ["ps", "-ax", "-o", "pid=,command="],
        capture_output=True,
        text=True,
        check=False,
    )
    return webgpt_app_pids(result.stdout or "")


def command_for_pid(pid: int, run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> str | None:
    result = run(
        ["ps", "-p", str(pid), "-o", "command="],
        capture_output=True,
        text=True,
        check=False,
    )
    cmd = (result.stdout or "").strip()
    return cmd or None


def stop_owned_pids(
    pids: Iterable[int],
    *,
    signal_pid: Callable[[int, int], None] = os.kill,
    command_of: Callable[[int], str | None] = command_for_pid,
    sig: int = signal.SIGTERM,
) -> list[int]:
    stopped: list[int] = []
    for pid in pids:
        cmd = command_of(pid)
        if not cmd or not is_webgpt_runtime_command(cmd):
            continue
        try:
            signal_pid(pid, sig)
        except ProcessLookupError:
            continue
        except PermissionError:
            continue
        stopped.append(pid)
    return stopped
