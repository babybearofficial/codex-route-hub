from __future__ import annotations

import json
import os
import signal
import subprocess
import time
import urllib.request
import hashlib
import shutil
from collections.abc import Callable
from pathlib import Path

from .detect import is_port_open, start_webgpt_app, stop_webgpt_app
from .paths import DEFAULT_BUNDLE_ID, DEFAULT_HOST, DEFAULT_PORT
from .process import command_for_pid, is_webgpt_command, list_webgpt_pids, stop_owned_pids


class OfficialRoute:
    def __init__(self, bun: Path, cli: Path, *, home: Path | None = None, codex_home: Path | None = None) -> None:
        self.bun = bun
        self.cli = cli
        self.home = home
        self.codex_home = codex_home

    def run(self, *args: str, timeout: float = 45, json_output: bool = True, allow_failure: bool = False) -> dict:
        env = dict(os.environ)
        if self.home is not None:
            env["CODEX_CHATGPT_WEB_HOME"] = str(self.home)
        if self.codex_home is not None:
            env["CODEX_HOME"] = str(self.codex_home)
        result = subprocess.run([str(self.bun), str(self.cli), *args], capture_output=True,
                                text=True, check=False, timeout=timeout, env=env)
        if result.returncode and not allow_failure:
            # CLI diagnostics can contain private config or runtime credentials.
            message = (result.stderr or "").strip()
            if self.home:
                def scrub(value):
                    nonlocal message
                    if isinstance(value, dict):
                        for key, item in value.items():
                            if any(word in key.lower() for word in ("token", "secret", "key")) and isinstance(item, str):
                                message = message.replace(item, "[redacted]") if item else message
                            else:
                                scrub(item)
                    elif isinstance(value, list):
                        for item in value:
                            scrub(item)
                for path in (self.home / "config.json", self.home / "runtime/launcher-browser.json"):
                    if path.exists():
                        scrub(json.loads(path.read_text()))
            raise RuntimeError(f"Web GPT {args[0]} failed (exit {result.returncode}): {message[:1200]}")
        if not json_output:
            return {}
        parsed = json.loads(result.stdout)
        if not isinstance(parsed, dict):
            raise RuntimeError("Web GPT returned non-object JSON")
        return parsed

    def _run(self, action: str) -> dict:
        return self.run("route", action)

    def status(self) -> dict:
        return self._run("status")

    def connect(self) -> dict:
        return self._run("connect")

    def disconnect(self) -> dict:
        result = self._run("disconnect")
        status = self.status()
        if status.get("active") or status.get("errors"):
            raise RuntimeError("Route restoration did not verify; journal retained")
        return result

    def finish_off(self) -> None:
        """Retire the inactive journal so next activation records a fresh baseline."""
        if self.home is None:
            return
        status = self.status()
        if status.get("active") or status.get("errors"):
            raise RuntimeError("Cannot retire an active or invalid integration journal")
        folder = self.home / "codex"
        archive = folder / "routing-history" / str(time.time_ns())
        if self.codex_home is not None:
            config = self.codex_home / "config.toml"
            if config.exists() and (folder / "integration-journal.json").exists():
                archive.mkdir(parents=True, exist_ok=True, mode=0o700)
                (archive / "baseline.json").write_text(json.dumps({
                    "sha256": hashlib.sha256(config.read_bytes()).hexdigest(),
                    "configPath": str(config),
                }))
        for name in ("integration-journal.json", "integration-journal.recovery.json"):
            source = folder / name
            if source.exists():
                archive.mkdir(parents=True, exist_ok=True, mode=0o700)
                source.rename(archive / name)

    def restore_checkpoint(self) -> None:
        """Reuse an inactive journal only when the entire prior baseline is identical."""
        if self.home is None or self.codex_home is None:
            return
        target = self.home / "codex/integration-journal.json"
        config = self.codex_home / "config.toml"
        if target.exists() or not config.exists():
            return
        history = self.home / "codex/routing-history"
        if not history.exists():
            return
        for folder in sorted(history.iterdir(), reverse=True):
            metadata = folder / "baseline.json"
            source = folder / "integration-journal.json"
            if not metadata.exists() or not source.exists():
                continue
            baseline = json.loads(metadata.read_text())
            journal = json.loads(source.read_text())
            if (baseline.get("configPath") == str(config)
                    and baseline.get("sha256") == hashlib.sha256(config.read_bytes()).hexdigest()
                    and journal.get("configPath") == str(config)
                    and journal.get("active") is False):
                shutil.copyfile(source, target)
                target.chmod(0o600)
            return

    def prepare(self) -> bool:
        if self.home is None:
            return False
        # Startup may perform its own version migration. Let its single writer
        # finish before starting another setup command against the same journal.
        time.sleep(2)
        deadline = time.monotonic() + 150
        while True:
            processes = subprocess.run(["ps", "-ax", "-o", "command="], capture_output=True,
                                       text=True, timeout=5, check=False).stdout.splitlines()
            installing = any(is_webgpt_command(command) and "cli.js setup " in command
                             for command in processes)
            if not installing:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Launcher setup is still running; retry after it finishes")
            time.sleep(1)
        config = json.loads((self.home / "config.json").read_text())
        version = self.cli.parent.parent.name.split("-", 1)[0]
        status = self.status()
        if status.get("errors"):
            raise RuntimeError("Integration journal conflicts with current config; preserved for recovery")
        if status.get("installed") and config.get("releaseVersion") == version:
            return False
        if config.get("browserHost") == "launcher":
            descriptor = self.home / "runtime" / "launcher-browser.json"
            deadline = time.monotonic() + 15
            while True:
                try:
                    owner = json.loads(descriptor.read_text())["pid"]
                    os.kill(owner, 0)
                    break
                except (OSError, ValueError, KeyError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Launcher browser did not become available")
                    time.sleep(0.25)
        args = ["setup", "--full" if config.get("mode") == "full" else "--browser-only",
                "--replace-codex-route", "--acknowledge-unofficial", "--restart-service",
                "--port", str(config.get("port", DEFAULT_PORT)),
                "--subagent-protocol", config.get("subagentProtocol", "compatibility-v1")]
        if config.get("browserHost") == "launcher":
            args += ["--browser-host-descriptor", str(self.home / "runtime" / "launcher-browser.json")]
        args += ["--zero-risk-browser-interaction" if config.get("browserInteractionMode") == "manual"
                 else "--automatic-browser-interaction"]
        args += ["--bigger-context" if config.get("experimentalBiggerContext") else "--standard-context"]
        if config.get("browserInteractionMode") == "manual":
            args += ["--zero-risk-pro" if config.get("zeroRiskProEnabled") else "--zero-risk-default"]
        if config.get("autoApproveToolCalls"):
            args += ["--auto-approve-tool-calls"]
        # The launcher refreshes its browser session during startup. Wait for that
        # finite operation rather than racing it and tearing down a healthy login.
        for attempt in range(8):
            try:
                self.run(*args, "--preflight-only", json_output=False)
                break
            except RuntimeError as exc:
                if "already busy with session refresh" not in str(exc) or attempt == 7:
                    raise
                time.sleep(2)
        self._stop_orphan(config)
        deadline = time.monotonic() + 120
        while True:
            try:
                self.run(*args, timeout=180, json_output=False)
                break
            except RuntimeError as exc:
                if "already busy with session refresh" not in str(exc) or time.monotonic() >= deadline:
                    raise
                time.sleep(3)
        return True

    def _stop_orphan(self, config: dict) -> None:
        """Retire only this installation's idle daemon before the launcher takes over."""
        base = f"http://{config.get('host', DEFAULT_HOST)}:{config.get('port', DEFAULT_PORT)}"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(base + "/healthz", timeout=2) as response:
                health = json.load(response)
        except OSError:
            return
        if health.get("service") != "codex-chatgpt-web":
            raise RuntimeError("Bridge port belongs to another service")
        pid = health.get("pid")
        command = command_for_pid(pid) if isinstance(pid, int) else None
        if not command or not is_webgpt_command(command):
            raise RuntimeError("Cannot establish daemon process ownership")
        def control(action):
            request = urllib.request.Request(base + "/admin/" + action, data=b"", method="POST",
                headers={"Authorization": "Bearer " + config["controlToken"]})
            with opener.open(request, timeout=5) as response:
                return json.load(response)
        drained = control("drain")
        if (drained.get("active_http_turns") != 0 or drained.get("active_browser_turns") != 0
                or drained.get("accepting_turns") is not False):
            control("resume")
            raise RuntimeError("Web GPT has active turns; cannot upgrade its runtime")
        control("shutdown")
        deadline = time.monotonic() + 10
        while is_port_open(config.get("host", DEFAULT_HOST), config.get("port", DEFAULT_PORT)):
            if time.monotonic() >= deadline:
                raise RuntimeError("Old Web GPT daemon did not release the bridge port")
            time.sleep(0.2)

    def verify(self) -> str:
        report = self.run("doctor", "--json", timeout=55, allow_failure=True)
        errors = [c.get("message", c.get("id", "unknown")) for c in report.get("checks", [])
                  if c.get("status") == "error"]
        if not report.get("ok") and not errors:
            errors = ["Runtime verification did not report ready"]
        return "; ".join(errors)



class MacWebGptApp:
    def __init__(
        self,
        name: str,
        *,
        bundle_id: str = DEFAULT_BUNDLE_ID,
        home: Path | None = None,
        bun: Path | None = None,
        cli: Path | None = None,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        popen: Callable[..., subprocess.Popen] = subprocess.Popen,
        sleep: Callable[[float], None] = time.sleep,
        port_open: Callable[[str, int], bool] = is_port_open,
        list_pids: Callable[[], tuple[int, ...]] = list_webgpt_pids,
        command_of: Callable[[int], str | None] = command_for_pid,
        signal_pid: Callable[[int, int], None] = os.kill,
    ) -> None:
        self.name = name
        self.bundle_id = bundle_id
        self.home = home
        self.bun = bun
        self.cli = cli
        self.host = host
        self.port = port
        self.popen = popen
        self.sleep = sleep
        self.port_open = port_open
        self.list_pids = list_pids
        self.command_of = command_of
        self.signal_pid = signal_pid

    def start(self) -> None:
        start_webgpt_app(self.name, self.bundle_id)

    def stop(self) -> None:
        stop_webgpt_app(self.name, self.bundle_id)

    def ensure_runtime(self) -> None:
        if self.home is not None:
            config_path = self.home / "config.json"
            if config_path.exists() and json.loads(config_path.read_text()).get("browserHost") == "launcher":
                # The launcher must own both daemon and tunnel. Never create an orphan serve.
                self.stop()
                self.stop_runtime()
                self.start()
                return
        if self.port_open(self.host, self.port):
            return
        if self.home is None or self.bun is None or self.cli is None:
            return
        logs = self.home / "logs"
        runtime = self.home / "runtime"
        logs.mkdir(parents=True, exist_ok=True)
        runtime.mkdir(parents=True, exist_ok=True)
        log_path = logs / "codex-routing-serve.log"
        if log_path.exists() and log_path.stat().st_size > 5 * 1024 * 1024:
            log_path.replace(logs / "codex-routing-serve.log.1")
        pid_path = runtime / "codex-routing-serve.pid"
        if pid_path.is_file():
            raw = pid_path.read_text().strip()
            if raw.isdigit():
                cmd = self.command_of(int(raw))
                if cmd and is_webgpt_command(cmd):
                    return
        with log_path.open("ab") as log:
            proc = self.popen(
                [str(self.bun), str(self.cli), "serve"],
                stdout=log,
                stderr=log,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
                env={**os.environ, "CODEX_CHATGPT_WEB_HOME": str(self.home)},
            )
        if proc.pid:
            pid_path.write_text(str(proc.pid))

    def stop_runtime(self) -> None:
        pids: set[int] = set(self.list_pids())
        if self.home is not None:
            pids.update(_pids_from_home(self.home))
        stop_owned_pids(
            sorted(pids),
            signal_pid=self.signal_pid,
            command_of=self.command_of,
            sig=signal.SIGTERM,
        )
        self.sleep(0.4)
        leftovers = [pid for pid in pids if self.command_of(pid)]
        stop_owned_pids(
            leftovers,
            signal_pid=self.signal_pid,
            command_of=self.command_of,
            sig=signal.SIGKILL,
        )
        pid_path = None if self.home is None else self.home / "runtime" / "codex-routing-serve.pid"
        if pid_path is not None and pid_path.is_file():
            pid_path.unlink(missing_ok=True)


def _pids_from_home(home: Path) -> set[int]:
    found: set[int] = set()
    pid_path = home / "runtime" / "codex-routing-serve.pid"
    if pid_path.is_file():
        raw = pid_path.read_text().strip()
        if raw.isdigit():
            found.add(int(raw))
    supervisor = home / "runtime" / "launcher-supervisor.json"
    if supervisor.is_file():
        try:
            data = json.loads(supervisor.read_text())
        except json.JSONDecodeError:
            data = {}
        if isinstance(data, dict):
            for key in ("ownerPid", "daemonPid", "tunnelPid"):
                value = data.get(key)
                if isinstance(value, int) and value > 0:
                    found.add(value)
    return found
