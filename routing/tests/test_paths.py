from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from codex_routing.paths import locate_cli, locate_route_cli, read_bridge_port, read_webgpt_config


class LocateCliTest(unittest.TestCase):
    def test_prefers_runtime_command_from_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            pinned = home / "versions" / "5.0.0-darwin-arm64"
            newest = home / "versions" / "5.0.4-darwin-arm64"
            for root in (pinned, newest):
                (root / "runtime").mkdir(parents=True)
                (root / "app").mkdir(parents=True)
                (root / "runtime" / "bun").write_text("")
                (root / "app" / "cli.js").write_text("")
            (home / "config.json").write_text(
                json.dumps(
                    {
                        "releaseVersion": "5.0.0",
                        "runtimeCommand": [
                            str(pinned / "runtime" / "bun"),
                            str(pinned / "app" / "cli.js"),
                        ],
                    }
                )
            )
            bun, cli = locate_cli(home)
            self.assertEqual(bun, pinned / "runtime" / "bun")
            self.assertEqual(cli, pinned / "app" / "cli.js")
            route_bun, route_cli = locate_route_cli(home)
            self.assertEqual(route_bun, newest / "runtime" / "bun")
            self.assertEqual(route_cli, newest / "app" / "cli.js")

    def test_picks_newest_version_with_bun_and_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            old = home / "versions" / "5.0.0-darwin-arm64"
            new = home / "versions" / "5.0.4-darwin-arm64"
            for root in (old, new):
                (root / "runtime").mkdir(parents=True)
                (root / "app").mkdir(parents=True)
                (root / "runtime" / "bun").write_text("")
                (root / "app" / "cli.js").write_text("")
            bun, cli = locate_cli(home)
            self.assertEqual(bun, new / "runtime" / "bun")
            self.assertEqual(cli, new / "app" / "cli.js")


class ReadConfigTest(unittest.TestCase):
    def test_reads_host_and_port_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "host": "127.0.0.1",
                        "port": 17841,
                        "controlToken": "secret-must-not-leak",
                    }
                )
            )
            cfg = read_webgpt_config(path)
            self.assertEqual(cfg.host, "127.0.0.1")
            self.assertEqual(cfg.port, 17841)
            dumped = json.dumps(cfg.__dict__)
            self.assertNotIn("secret-must-not-leak", dumped)

    def test_default_port_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text("{}")
            self.assertEqual(read_bridge_port(path), 17841)


if __name__ == "__main__":
    unittest.main()
