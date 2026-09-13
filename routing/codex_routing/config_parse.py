from __future__ import annotations

import tomllib


def parse_openai_base_url(text: str) -> str | None:
    """Only the root setting routes Codex; provider tables are unrelated."""
    value = tomllib.loads(text).get("openai_base_url")
    return value if isinstance(value, str) else None
