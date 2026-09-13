from __future__ import annotations

import unittest

from codex_routing.config_parse import parse_openai_base_url


ACTIVE = """
model = "gpt-6-astra"
openai_base_url = "http://127.0.0.1:17841/v1"
network_access = "enabled"
"""

COMMENTED = """
model = "gpt-6-astra"
# openai_base_url = "http://127.0.0.1:17841/v1"
network_access = "enabled"
"""

INLINE_COMMENT = """
openai_base_url = "http://127.0.0.1:17841/v1"  # managed
"""

MISSING = """
model = "gpt-6-astra"
network_access = "enabled"
"""


class ParseOpenaiBaseUrlTest(unittest.TestCase):
    def test_reads_active_url(self) -> None:
        self.assertEqual(
            parse_openai_base_url(ACTIVE),
            "http://127.0.0.1:17841/v1",
        )

    def test_ignores_commented_url(self) -> None:
        self.assertIsNone(parse_openai_base_url(COMMENTED))

    def test_strips_inline_comment(self) -> None:
        self.assertEqual(
            parse_openai_base_url(INLINE_COMMENT),
            "http://127.0.0.1:17841/v1",
        )

    def test_missing_is_none(self) -> None:
        self.assertIsNone(parse_openai_base_url(MISSING))


if __name__ == "__main__":
    unittest.main()
