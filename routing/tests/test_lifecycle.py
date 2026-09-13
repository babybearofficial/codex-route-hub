from __future__ import annotations

import unittest

from codex_routing.paths import DEFAULT_BUNDLE_ID
from codex_routing.detect import start_app_argv, stop_app_argv


class AppLifecycleArgvTest(unittest.TestCase):
    def test_start_uses_bundle_id_not_chatgpt(self) -> None:
        argv = start_app_argv(DEFAULT_BUNDLE_ID)
        self.assertEqual(argv, ["open", "-g", "-b", DEFAULT_BUNDLE_ID])
        joined = " ".join(argv)
        self.assertNotIn("ChatGPT", joined)
        self.assertNotIn("com.openai.codex", joined)

    def test_stop_quits_only_webgpt_bundle_id(self) -> None:
        argv = stop_app_argv(DEFAULT_BUNDLE_ID)
        self.assertEqual(
            argv,
            ["osascript", "-e", f'tell application id "{DEFAULT_BUNDLE_ID}" to quit'],
        )
        joined = " ".join(argv)
        self.assertIn("dev.codexwebgpt.launcher", joined)
        self.assertNotIn("ChatGPT", joined)
        self.assertNotIn("com.openai.codex", joined)
        self.assertNotIn('tell application "Codex"', joined)


if __name__ == "__main__":
    unittest.main()
