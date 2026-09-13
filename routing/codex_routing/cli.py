from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .controller import SyncResult
from .decide import Action
from .detect import route_url_from_toml
from .factory import build_runtime
from .paths import DEFAULT_BUNDLE_ID
from .process import list_webgpt_pids
from .watch import Watcher


def _status_payload(runtime) -> dict:
    snap = runtime.controller.probe()
    return {
        "webgpt_process": snap.webgpt_process,
        "bridge_listening": snap.bridge_listening,
        "route_active": snap.route_active,
        "runtime_ready": snap.runtime_ready,
        "bridge": f"{runtime.config.host}:{runtime.config.port}",
        "route_url": route_url_from_toml(runtime.toml_path),
        "cli": str(runtime.cli),
        "serve_cli": str(runtime.serve_cli),
        "bundle_id": DEFAULT_BUNDLE_ID,
        "webgpt_pids": list(list_webgpt_pids()),
        "codex_app": "untouched",
        "desired": "off" if runtime.controller.intent.is_off() else "on",
    }


def _print_result(result: SyncResult) -> None:
    print(
        json.dumps(
            {
                "action": result.action.value,
                "webgpt_process": result.snapshot.webgpt_process,
                "bridge_listening": result.snapshot.bridge_listening,
                "route_active": result.snapshot.route_active,
                "detail": result.detail,
            },
            indent=2,
            ensure_ascii=False,
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="codex-route",
        description="Sync Codex openai_base_url with Codex Web GPT (17841).",
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="status",
        choices=("status", "sync", "on", "off", "watch", "gui"),
        help="status | sync | on | off | watch | gui",
    )
    parser.add_argument("--home", type=Path, default=None)
    parser.add_argument("--interval", type=float, default=2.0)
    args = parser.parse_args(argv)

    if args.command == "gui":
        from .gui import run_gui

        run_gui()
        return 0

    kwargs = {}
    if args.home is not None:
        kwargs["home"] = args.home
    runtime = build_runtime(**kwargs)

    if args.command == "status":
        print(json.dumps(_status_payload(runtime), indent=2, ensure_ascii=False))
        return 0
    if args.command == "sync":
        _print_result(runtime.controller.sync())
        return 0
    if args.command == "on":
        result = runtime.controller.enable()
        _print_result(result)
        return 0 if result.ok and result.snapshot.webgpt_healthy and result.snapshot.route_active else 1
    if args.command == "off":
        result = runtime.controller.disable()
        _print_result(result)
        return 0 if result.ok else 1
    if args.command == "watch":
        watcher = Watcher(runtime.controller, interval=args.interval)

        def _on_tick(result: SyncResult) -> None:
            if result.action is not Action.NONE:
                _print_result(result)

        print("watching: Web GPT on → route on; Web GPT off → route off", flush=True)
        try:
            watcher.run(on_tick=_on_tick)
        except KeyboardInterrupt:
            watcher.stop()
            print("stopped", flush=True)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
