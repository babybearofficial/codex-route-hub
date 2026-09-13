from __future__ import annotations

import unittest
from pathlib import Path

from codex_routing.official import MacWebGptApp
from tests.test_process import CHATGPT_HELPER, WEB_GPT_APP, WEB_GPT_SERVE


class FakeProc:
    def __init__(self, pid: int) -> None:
        self.pid = pid


class MacWebGptAppRuntimeTest(unittest.TestCase):
    def test_ensure_runtime_spawns_pinned_serve(self) -> None:
        spawned: list[list[str]] = []

        def popen(argv, **_kwargs):
            spawned.append(list(argv))
            return FakeProc(62002)

        with self._tmp() as home:
            bun = home / "bun"
            cli = home / "cli.js"
            bun.write_text("")
            cli.write_text("")
            app = MacWebGptApp(
                "Codex Web GPT",
                home=home,
                bun=bun,
                cli=cli,
                popen=popen,
                sleep=lambda _s: None,
                port_open=lambda _h, _p: False,
                list_pids=lambda: (),
                command_of=lambda _pid: None,
                signal_pid=lambda _pid, _sig: None,
            )
            app.ensure_runtime()
            self.assertEqual(spawned, [[str(bun), str(cli), "serve"]])
            self.assertEqual((home / "runtime" / "codex-routing-serve.pid").read_text(), "62002")

    def test_ensure_runtime_does_not_double_spawn_live_serve(self) -> None:
        spawned: list[list[str]] = []

        def popen(argv, **_kwargs):
            spawned.append(list(argv))
            return FakeProc(99999)

        with self._tmp() as home:
            bun = home / "bun"
            cli = home / "cli.js"
            bun.write_text("")
            cli.write_text("")
            runtime = home / "runtime"
            runtime.mkdir()
            (runtime / "codex-routing-serve.pid").write_text("62002")
            app = MacWebGptApp(
                "Codex Web GPT",
                home=home,
                bun=bun,
                cli=cli,
                popen=popen,
                sleep=lambda _s: None,
                port_open=lambda _h, _p: False,
                list_pids=lambda: (62002,),
                command_of=lambda pid: WEB_GPT_SERVE.split(" ", 1)[1] if pid == 62002 else None,
                signal_pid=lambda _pid, _sig: None,
            )
            app.ensure_runtime()
            self.assertEqual(spawned, [])

    def test_stop_runtime_skips_chatgpt_pid(self) -> None:
        killed: list[tuple[int, int]] = []
        commands = {
            18181: CHATGPT_HELPER.split(" ", 1)[1],
            62001: WEB_GPT_APP.split(" ", 1)[1],
            62002: WEB_GPT_SERVE.split(" ", 1)[1],
        }
        app = MacWebGptApp(
            "Codex Web GPT",
            sleep=lambda _s: None,
            port_open=lambda _h, _p: False,
            list_pids=lambda: (18181, 62001, 62002),
            command_of=commands.get,
            signal_pid=lambda pid, sig: killed.append((pid, sig)),
        )
        app.stop_runtime()
        killed_pids = [pid for pid, _sig in killed]
        self.assertNotIn(18181, killed_pids)
        self.assertEqual(set(killed_pids), {62001, 62002})

    def _tmp(self):
        import tempfile
        from contextlib import contextmanager

        @contextmanager
        def ctx():
            with tempfile.TemporaryDirectory() as tmp:
                yield Path(tmp)

        return ctx()


if __name__ == "__main__":
    unittest.main()
