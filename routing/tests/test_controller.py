from __future__ import annotations

import unittest
from dataclasses import dataclass, field

from codex_routing.controller import Controller
from codex_routing.decide import Action, Snapshot
from codex_routing.intent import MemoryIntent


@dataclass
class FakeRoute:
    active: bool = False
    connects: int = 0
    disconnects: int = 0

    def connect(self) -> dict:
        self.connects += 1
        self.active = True
        return {"active": True}

    def disconnect(self) -> dict:
        self.disconnects += 1
        self.active = False
        return {"active": False}


@dataclass
class FakeApp:
    running: bool = False
    starts: int = 0
    stops: int = 0
    runtime_ensures: int = 0
    runtime_stops: int = 0
    on_ensure: object | None = None

    def start(self) -> None:
        self.starts += 1
        self.running = True

    def stop(self) -> None:
        self.stops += 1
        self.running = False

    def ensure_runtime(self) -> None:
        self.runtime_ensures += 1
        if callable(self.on_ensure):
            self.on_ensure()

    def stop_runtime(self) -> None:
        self.runtime_stops += 1


@dataclass
class FakeWorld:
    process: bool = False
    bridge: bool = False
    route: FakeRoute = field(default_factory=FakeRoute)
    app: FakeApp = field(default_factory=FakeApp)
    port: int = 17841

    def snapshot(self) -> Snapshot:
        return Snapshot(
            webgpt_process=self.process or self.app.running,
            bridge_listening=self.bridge,
            route_active=self.route.active,
        )


class ControllerSyncTest(unittest.TestCase):
    def test_sync_connects_when_bridge_is_up(self) -> None:
        world = FakeWorld(process=True, bridge=True)
        ctl = Controller(probe=world.snapshot, route=world.route, app=world.app)
        result = ctl.sync()
        self.assertEqual(result.action, Action.CONNECT)
        self.assertEqual(world.route.connects, 1)
        self.assertEqual(world.route.disconnects, 0)

    def test_sync_disconnects_dead_bridge(self) -> None:
        world = FakeWorld(process=False, bridge=False)
        world.route.active = True
        ctl = Controller(probe=world.snapshot, route=world.route, app=world.app)
        result = ctl.sync()
        self.assertEqual(result.action, Action.DISCONNECT)
        self.assertEqual(world.route.disconnects, 1)

    def test_sync_noop_when_already_aligned(self) -> None:
        world = FakeWorld(process=False, bridge=False)
        ctl = Controller(probe=world.snapshot, route=world.route, app=world.app)
        result = ctl.sync()
        self.assertEqual(result.action, Action.NONE)
        self.assertEqual(world.route.connects, 0)
        self.assertEqual(world.route.disconnects, 0)

    def test_sync_tears_down_orphan_serve_when_app_closed(self) -> None:
        world = FakeWorld(process=False, bridge=True)
        world.route.active = True
        ctl = Controller(probe=world.snapshot, route=world.route, app=world.app)
        result = ctl.sync()
        self.assertEqual(result.action, Action.DISCONNECT)
        self.assertEqual(world.route.disconnects, 1)
        self.assertEqual(world.app.runtime_stops, 1)
        self.assertEqual(world.app.starts, 0)

    def test_user_off_blocks_reconnect_after_disable(self) -> None:
        world = FakeWorld(process=True, bridge=True)
        world.route.active = True
        world.app.running = True
        intent = MemoryIntent()
        ctl = Controller(
            probe=world.snapshot,
            route=world.route,
            app=world.app,
            intent=intent,
        )
        ctl.disable()
        world.process = True
        world.bridge = True
        world.app.running = True
        result = ctl.sync()
        self.assertTrue(intent.is_off())
        self.assertEqual(world.route.connects, 0)
        self.assertNotEqual(result.action, Action.CONNECT)


class ControllerEnableDisableTest(unittest.TestCase):
    def test_enable_starts_app_waits_then_connects(self) -> None:
        world = FakeWorld()

        def wait_bridge(_timeout: float) -> bool:
            world.bridge = True
            world.process = True
            return True

        ctl = Controller(
            probe=world.snapshot,
            route=world.route,
            app=world.app,
            wait_bridge=wait_bridge,
        )
        result = ctl.enable()
        self.assertEqual(world.app.starts, 1)
        self.assertEqual(result.action, Action.CONNECT)
        self.assertTrue(world.route.active)

    def test_disable_still_stops_app_if_route_disconnect_fails(self) -> None:
        world = FakeWorld(process=True, bridge=True)
        world.route.active = True
        world.app.running = True

        def boom() -> dict:
            raise RuntimeError("Invalid Codex integration journal")

        world.route.disconnect = boom  # type: ignore[method-assign]
        ctl = Controller(probe=world.snapshot, route=world.route, app=world.app)
        result = ctl.disable()
        self.assertEqual(world.app.stops, 1)
        self.assertEqual(world.app.runtime_stops, 1)
        self.assertEqual(result.action, Action.DISCONNECT)
        self.assertIn("Invalid Codex integration journal", result.detail)

    def test_disable_disconnects_then_stops_app(self) -> None:
        world = FakeWorld(process=True, bridge=True)
        world.route.active = True
        world.app.running = True
        ctl = Controller(probe=world.snapshot, route=world.route, app=world.app)
        result = ctl.disable()
        self.assertEqual(world.route.disconnects, 1)
        self.assertEqual(world.app.stops, 1)
        self.assertEqual(world.app.runtime_stops, 1)
        self.assertEqual(result.action, Action.DISCONNECT)
        self.assertFalse(world.route.active)

    def test_enable_falls_back_to_runtime_when_gui_does_not_bind(self) -> None:
        world = FakeWorld()
        waits = {"n": 0}

        def wait_bridge(_timeout: float) -> bool:
            waits["n"] += 1
            return world.bridge

        def bring_bridge_up() -> None:
            world.bridge = True
            world.process = True

        world.app.on_ensure = bring_bridge_up
        ctl = Controller(
            probe=world.snapshot,
            route=world.route,
            app=world.app,
            wait_bridge=wait_bridge,
        )
        result = ctl.enable()
        self.assertEqual(world.app.starts, 1)
        self.assertEqual(world.app.runtime_ensures, 1)
        self.assertGreaterEqual(waits["n"], 2)
        self.assertEqual(result.action, Action.CONNECT)
        self.assertTrue(world.route.active)

    def test_enable_gui_wait_is_shorter_than_total(self) -> None:
        world = FakeWorld()
        seen: list[float] = []

        def wait_bridge(timeout: float) -> bool:
            seen.append(timeout)
            if len(seen) == 1:
                return False
            world.bridge = True
            world.process = True
            return True

        ctl = Controller(
            probe=world.snapshot,
            route=world.route,
            app=world.app,
            wait_bridge=wait_bridge,
        )
        result = ctl.enable(timeout=90.0)
        self.assertEqual(world.app.runtime_ensures, 1)
        self.assertEqual(result.action, Action.CONNECT)
        self.assertLess(seen[0], 90.0)
        self.assertGreater(seen[1], 0.0)


if __name__ == "__main__":
    unittest.main()
