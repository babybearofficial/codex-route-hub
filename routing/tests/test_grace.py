from __future__ import annotations

import unittest

from codex_routing.decide import Snapshot
from codex_routing.watch import GraceTracker


class GraceTrackerTest(unittest.TestCase):
    def test_restart_is_graced_then_expires(self) -> None:
        now = {"t": 0.0}
        tracker = GraceTracker(seconds=8.0, clock=lambda: now["t"])
        restarting = Snapshot(webgpt_process=True, bridge_listening=False, route_active=True)
        self.assertTrue(tracker.in_grace(restarting))
        now["t"] = 7.9
        self.assertTrue(tracker.in_grace(restarting))
        now["t"] = 8.1
        self.assertFalse(tracker.in_grace(restarting))

    def test_healthy_or_fully_down_clears_grace(self) -> None:
        tracker = GraceTracker(seconds=8.0, clock=lambda: 0.0)
        healthy = Snapshot(webgpt_process=True, bridge_listening=True, route_active=True)
        down = Snapshot(webgpt_process=False, bridge_listening=False, route_active=True)
        self.assertFalse(tracker.in_grace(healthy))
        self.assertFalse(tracker.in_grace(down))


if __name__ == "__main__":
    unittest.main()
