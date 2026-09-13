import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex_routing.config_parse import parse_openai_base_url
from codex_routing.detect import collect_snapshot
from codex_routing.controller import Controller
from codex_routing.official import OfficialRoute, MacWebGptApp
from tests.test_controller import FakeWorld


class RegressionTests(unittest.TestCase):
    def test_provider_url_is_not_root_route(self):
        self.assertIsNone(parse_openai_base_url('[model_providers.mine]\nopenai_base_url="https://example.com/v1"\n'))

    def test_original_custom_route_is_not_webgpt(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'config.toml'
            p.write_text('openai_base_url="https://example.com/v1"\n')
            with patch('codex_routing.detect.is_webgpt_process', return_value=False), patch('codex_routing.detect.is_port_open', return_value=False):
                self.assertFalse(collect_snapshot(toml_path=p).route_active)

    def test_off_disconnects_even_when_root_route_missing(self):
        w = FakeWorld()
        ctl = Controller(w.snapshot, w.route, w.app)
        ctl.disable()
        self.assertEqual(w.route.disconnects, 1)

    def test_runtime_failure_rolls_back_and_blocks_watch_reconnect(self):
        w = FakeWorld(process=True, bridge=True)
        w.route.verify = lambda: 'Tunnel runtime is not ready'
        ctl = Controller(w.snapshot, w.route, w.app)
        result = ctl.enable()
        self.assertFalse(result.ok)
        self.assertFalse(w.route.active)
        self.assertTrue(ctl.intent.is_off())
        self.assertIn('Tunnel', result.detail)

    def test_off_stops_writer_before_restoring(self):
        w = FakeWorld()
        events = []
        w.app.stop = lambda: events.append('app')
        w.app.stop_runtime = lambda: events.append('runtime')
        w.route.disconnect = lambda: events.append('restore')
        Controller(w.snapshot, w.route, w.app).disable()
        self.assertEqual(events, ['app', 'runtime', 'restore'])

    def test_launcher_never_spawns_unowned_serve(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            (home / 'config.json').write_text(json.dumps({'browserHost': 'launcher'}))
            app = MacWebGptApp('Codex Web GPT', home=home)
            with patch.object(app, 'stop') as stop, patch.object(app, 'stop_runtime'), patch.object(app, 'start') as start, patch.object(app, 'popen') as spawn:
                app.ensure_runtime()
                stop.assert_called_once()
                start.assert_called_once()
                spawn.assert_not_called()

    def test_cli_scopes_both_homes(self):
        route = OfficialRoute(Path('/bun'), Path('/cli'), home=Path('/private/web'), codex_home=Path('/private/codex'))
        with patch('codex_routing.official.subprocess.run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = '{}'
            route.status()
            env = run.call_args.kwargs['env']
            self.assertEqual(env['CODEX_HOME'], '/private/codex')
            self.assertEqual(env['CODEX_CHATGPT_WEB_HOME'], '/private/web')

    def test_retire_only_verified_inactive_journal(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            (home / 'codex').mkdir()
            journal = home / 'codex/integration-journal.json'
            journal.write_text('{"active":false}')
            route = OfficialRoute(Path('/bun'), Path('/cli'), home=home)
            with patch.object(route, 'status', return_value={'active': True}):
                with self.assertRaises(RuntimeError):
                    route.finish_off()
            self.assertTrue(journal.exists())
            with patch.object(route, 'status', return_value={'active': False, 'errors': []}):
                route.finish_off()
            self.assertFalse(journal.exists())
            self.assertEqual(len(list((home / 'codex/routing-history').glob('*/integration-journal.json'))), 1)

class LifecycleIsolationTests(unittest.TestCase):
    def test_cleanup_never_kills_route_or_setup_cli(self):
        from codex_routing.process import stop_owned_pids
        base = '/Users/example/.codex-chatgpt-web/versions/5.0.6-darwin-arm64/'
        commands = {1: base+'runtime/bun '+base+'app/cli.js route disconnect',
                    2: base+'runtime/bun '+base+'app/cli.js setup --full',
                    3: base+'runtime/bun '+base+'app/cli.js serve'}
        killed = []
        stop_owned_pids(commands, command_of=commands.get, signal_pid=lambda pid, sig: killed.append(pid))
        self.assertEqual(killed, [3])

    def test_lock_reentrant_and_releases_file_descriptor(self):
        from codex_routing.locking import OperationLock
        with tempfile.TemporaryDirectory() as d:
            lock = OperationLock(Path(d)/'lock')
            for _ in range(100):
                with lock:
                    with lock:
                        self.assertEqual(lock.depth, 2)
                self.assertEqual(lock.depth, 0)
                self.assertIsNone(lock.fd)

    def test_not_ready_runtime_never_auto_connects(self):
        from codex_routing.decide import Snapshot, decide_route_action, Action
        self.assertEqual(decide_route_action(Snapshot(True,True,False,False)), Action.NONE)


class CheckpointTests(unittest.TestCase):
    def test_checkpoint_only_reused_for_exact_baseline(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)/"web"; codex = Path(d)/"codex"
            (home/"codex").mkdir(parents=True); codex.mkdir()
            config = codex/"config.toml"; config.write_text('model="original"\n')
            journal = home/"codex/integration-journal.json"
            journal.write_text(json.dumps({"active":False,"configPath":str(config)}))
            route = OfficialRoute(Path('/bun'),Path('/cli'),home=home,codex_home=codex)
            with patch.object(route,'status',return_value={"active":False,"errors":[]}):
                route.finish_off()
            route.restore_checkpoint()
            self.assertTrue(journal.exists())
            journal.unlink()
            config.write_text('model="changed-while-off"\n')
            route.restore_checkpoint()
            self.assertFalse(journal.exists())
