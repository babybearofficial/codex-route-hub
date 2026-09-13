from __future__ import annotations

import unittest

from codex_routing.controller import Controller
from codex_routing.gui import close_manager
from tests.test_controller import FakeWorld


class GuiShutdownTest(unittest.TestCase):
    def test_close_manager_disconnects_stale_route_then_destroys(self) -> None:
        world = FakeWorld(process=False, bridge=False)
        world.route.active = True
        ctl = Controller(probe=world.snapshot, route=world.route, app=world.app)
        destroyed: list[bool] = []

        result = close_manager(ctl, lambda: destroyed.append(True))

        self.assertEqual(world.route.disconnects, 1)
        self.assertFalse(world.route.active)
        self.assertEqual(world.app.runtime_stops, 1)
        self.assertEqual(destroyed, [True])
        self.assertEqual(result.action.value, "disconnect")
        self.assertEqual(world.app.starts, 0)


if __name__ == "__main__":
    unittest.main()
