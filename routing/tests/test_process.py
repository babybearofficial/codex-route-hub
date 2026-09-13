from __future__ import annotations

import unittest

from codex_routing.process import (
    is_protected_command,
    is_webgpt_app_command,
    is_webgpt_command,
    stop_owned_pids,
    webgpt_pids,
)


CHATGPT_HELPER = (
    "18181 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/"
    "Versions/152.0.7977.83/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)"
)
CHATGPT_MAIN = "18137 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
CODEX_CLI = "56458 /Applications/ChatGPT.app/Contents/Resources/codex exec --json"
COMPUTER_USE = (
    "77109 /Users/wickedmc/.codex/computer-use/Codex Computer Use.app/"
    "Contents/MacOS/SkyComputerUseService"
)
WEB_GPT_APP = (
    "62001 /Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT"
)
WEB_GPT_SERVE = (
    "62002 /Users/wickedmc/.codex-chatgpt-web/versions/5.0.0-darwin-arm64/runtime/bun "
    "/Users/wickedmc/.codex-chatgpt-web/versions/5.0.0-darwin-arm64/app/cli.js serve"
)
WEB_GPT_TUNNEL = (
    "62003 /Users/wickedmc/.codex-chatgpt-web/bin/tunnel-client connect --profile "
    "/Users/wickedmc/.codex-chatgpt-web/tunnel/profiles/codex-chatgpt-web.yaml"
)
ROUTING_GUI = "63001 python3 -m codex_routing gui"
PGREP_MENTION = "50656 pgrep -fl /Applications/Codex Web GPT.app"
SHELL_MENTION = (
    "64001 /bin/zsh -c echo hi; pgrep -fl /Applications/Codex Web GPT.app; "
    "python3 -m codex_routing off"
)


class ProcessClassificationTest(unittest.TestCase):
    def test_chatgpt_and_codex_app_are_protected(self) -> None:
        for line in (CHATGPT_HELPER, CHATGPT_MAIN, CODEX_CLI, COMPUTER_USE):
            cmd = line.split(" ", 1)[1]
            self.assertTrue(is_protected_command(cmd), cmd)
            self.assertFalse(is_webgpt_command(cmd), cmd)

    def test_app_closed_does_not_count_leftover_serve_as_gui(self) -> None:
        serve = WEB_GPT_SERVE.split(" ", 1)[1]
        app = WEB_GPT_APP.split(" ", 1)[1]
        self.assertTrue(is_webgpt_app_command(app))
        self.assertFalse(is_webgpt_app_command(serve))
        self.assertTrue(is_webgpt_command(serve))

    def test_webgpt_app_serve_and_tunnel_are_owned(self) -> None:
        for line in (WEB_GPT_APP, WEB_GPT_SERVE, WEB_GPT_TUNNEL):
            cmd = line.split(" ", 1)[1]
            self.assertTrue(is_webgpt_command(cmd), cmd)
            self.assertFalse(is_protected_command(cmd), cmd)

    def test_routing_gui_is_not_webgpt(self) -> None:
        cmd = ROUTING_GUI.split(" ", 1)[1]
        self.assertFalse(is_webgpt_command(cmd))
        self.assertFalse(is_protected_command(cmd))

    def test_commands_that_only_mention_webgpt_are_not_owned(self) -> None:
        for line in (PGREP_MENTION, SHELL_MENTION):
            cmd = line.split(" ", 1)[1]
            self.assertFalse(is_webgpt_command(cmd), cmd)

    def test_webgpt_pids_skip_protected_and_unrelated(self) -> None:
        listing = "\n".join(
            (
                CHATGPT_HELPER,
                CHATGPT_MAIN,
                CODEX_CLI,
                COMPUTER_USE,
                WEB_GPT_APP,
                WEB_GPT_SERVE,
                WEB_GPT_TUNNEL,
                ROUTING_GUI,
            )
        )
        self.assertEqual(webgpt_pids(listing), (62001, 62002, 62003))

    def test_stop_owned_pids_never_signals_chatgpt(self) -> None:
        killed: list[int] = []
        commands = {
            18181: CHATGPT_HELPER.split(" ", 1)[1],
            18137: CHATGPT_MAIN.split(" ", 1)[1],
            62001: WEB_GPT_APP.split(" ", 1)[1],
            62002: WEB_GPT_SERVE.split(" ", 1)[1],
        }

        stopped = stop_owned_pids(
            (18181, 18137, 62001, 62002),
            signal_pid=lambda pid, _sig: killed.append(pid),
            command_of=commands.get,
        )
        self.assertEqual(stopped, [62001, 62002])
        self.assertEqual(killed, [62001, 62002])


if __name__ == "__main__":
    unittest.main()
