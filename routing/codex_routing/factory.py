from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .controller import Controller
from .detect import collect_snapshot, wait_for_runtime
from .intent import FileIntent
from .locking import OperationLock
from .native import NativeAwareController, NativeClient
from .official import MacWebGptApp, OfficialRoute
from .paths import (
    DEFAULT_APP_NAME,
    DEFAULT_BUNDLE_ID,
    DEFAULT_CODEX_TOML,
    DEFAULT_HOME,
    WebGptConfig,
    locate_cli,
    locate_route_cli,
    locate_launcher_cli,
    read_webgpt_config,
)


@dataclass(frozen=True)
class Runtime:
    home: Path
    toml_path: Path
    bun: Path
    cli: Path
    serve_cli: Path
    config: WebGptConfig
    controller: Controller
    route: OfficialRoute


def build_runtime(
    home: Path = DEFAULT_HOME,
    toml_path: Path = DEFAULT_CODEX_TOML,
    app_name: str = DEFAULT_APP_NAME,
) -> Runtime:
    serve_bun, serve_cli = locate_cli(home)
    route_bun, route_cli = locate_launcher_cli(home)
    config = read_webgpt_config(home / "config.json")
    route = OfficialRoute(route_bun, route_cli, home=home, codex_home=toml_path.parent)
    controller = Controller(
        probe=lambda: collect_snapshot(config.host, config.port, toml_path, home),
        route=route,
        app=MacWebGptApp(
            app_name,
            bundle_id=DEFAULT_BUNDLE_ID,
            home=home,
            bun=serve_bun,
            cli=serve_cli,
            host=config.host,
            port=config.port,
        ),
        wait_bridge=lambda timeout: wait_for_runtime(home, config.host, config.port, timeout),
        intent=FileIntent(home / "runtime" / "codex-routing-user-off"),
    )
    controller.operation_lock = OperationLock(home / "runtime/codex-routing.lock")
    controller = NativeAwareController(controller, NativeClient(home))
    return Runtime(
        home=home,
        toml_path=toml_path,
        bun=route_bun,
        cli=route_cli,
        serve_cli=serve_cli,
        config=config,
        controller=controller,
        route=route,
    )
