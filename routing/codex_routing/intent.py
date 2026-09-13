from __future__ import annotations

from pathlib import Path


class MemoryIntent:
    def __init__(self) -> None:
        self._off = False

    def mark_off(self) -> None:
        self._off = True

    def mark_on(self) -> None:
        self._off = False

    def is_off(self) -> bool:
        return self._off


class FileIntent:
    def __init__(self, path: Path) -> None:
        self.path = path

    def mark_off(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("off\n")

    def mark_on(self) -> None:
        if self.path.is_file():
            self.path.unlink()

    def is_off(self) -> bool:
        return self.path.is_file()
