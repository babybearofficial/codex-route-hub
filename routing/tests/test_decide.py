from __future__ import annotations

import unittest

from codex_routing.decide import Action, Snapshot, decide_route_action


class DecideRouteActionTest(unittest.TestCase):
    def test_webgpt_healthy_and_route_off_connects(self) -> None:
        snap = Snapshot(webgpt_process=True, bridge_listening=True, route_active=False)
        self.assertEqual(decide_route_action(snap), Action.CONNECT)

    def test_webgpt_off_and_route_on_disconnects(self) -> None:
        snap = Snapshot(webgpt_process=False, bridge_listening=False, route_active=True)
        self.assertEqual(decide_route_action(snap), Action.DISCONNECT)

    def test_already_matched_on_is_noop(self) -> None:
        snap = Snapshot(webgpt_process=True, bridge_listening=True, route_active=True)
        self.assertEqual(decide_route_action(snap), Action.NONE)

    def test_already_matched_off_is_noop(self) -> None:
        snap = Snapshot(webgpt_process=False, bridge_listening=False, route_active=False)
        self.assertEqual(decide_route_action(snap), Action.NONE)

    def test_stale_route_with_dead_bridge_disconnects(self) -> None:
        snap = Snapshot(webgpt_process=True, bridge_listening=False, route_active=True)
        self.assertEqual(decide_route_action(snap), Action.DISCONNECT)

    def test_restart_grace_keeps_stale_route_briefly(self) -> None:
        snap = Snapshot(webgpt_process=True, bridge_listening=False, route_active=True)
        self.assertEqual(
            decide_route_action(snap, restart_grace=True),
            Action.NONE,
        )

    def test_orphan_bridge_without_app_does_not_connect(self) -> None:
        snap = Snapshot(webgpt_process=False, bridge_listening=True, route_active=False)
        self.assertEqual(decide_route_action(snap), Action.NONE)

    def test_orphan_bridge_with_stale_route_disconnects(self) -> None:
        snap = Snapshot(webgpt_process=False, bridge_listening=True, route_active=True)
        self.assertEqual(decide_route_action(snap), Action.DISCONNECT)

    def test_user_off_never_reconnects(self) -> None:
        snap = Snapshot(webgpt_process=True, bridge_listening=True, route_active=False)
        self.assertEqual(decide_route_action(snap, user_off=True), Action.NONE)
        snap_on = Snapshot(webgpt_process=True, bridge_listening=True, route_active=True)
        self.assertEqual(decide_route_action(snap_on, user_off=True), Action.DISCONNECT)


if __name__ == "__main__":
    unittest.main()
