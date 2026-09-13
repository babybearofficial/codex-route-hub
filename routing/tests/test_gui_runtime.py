import queue
import threading
import unittest
from types import SimpleNamespace

from codex_routing.gui import RoutingApp
from codex_routing.controller import SyncResult
from codex_routing.decide import Action, Snapshot


class GuiQueueTests(unittest.TestCase):
    def test_busy_user_action_is_queued_not_discarded(self):
        app = SimpleNamespace(_busy=True, _pending=None, _append_log=lambda message: None)
        action = lambda: None
        RoutingApp._run_bg(app, action, announce=True)
        self.assertEqual(app._pending, (action, True))
        RoutingApp._run_bg(app, lambda: None, announce=False)
        self.assertEqual(app._pending, (action, True))

    def test_worker_uses_queue_and_never_calls_tk(self):
        app = SimpleNamespace(_busy=False, _events=queue.Queue(maxsize=128))
        result = SyncResult(Action.NONE, Snapshot(False, False, False))
        RoutingApp._run_bg(app, lambda: result, announce=True)
        app._worker.join(timeout=2)
        self.assertFalse(app._worker.is_alive())
        self.assertEqual(app._events.get_nowait(), ('result', (result, True)))

    def test_worker_error_is_delivered(self):
        app = SimpleNamespace(_busy=False, _events=queue.Queue(maxsize=128))
        def fail():
            raise RuntimeError('test failure')
        RoutingApp._run_bg(app, fail)
        app._worker.join(timeout=2)
        self.assertEqual(app._events.get_nowait(), ('error', 'test failure'))
