import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from codex_routing.native import NativeClient


class NativeProtocolTest(unittest.TestCase):
    def test_live_loopback_protocol_and_descriptor_privacy(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert self.headers['Authorization'] == 'Bearer test-private-token'
                data = {'protocol': 'codex-routing-v1', 'enabled': body.get('enabled', True)}
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(data).encode())
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever); thread.start()
        try:
            with tempfile.TemporaryDirectory() as d:
                home = Path(d); (home/'runtime').mkdir()
                descriptor = home/'runtime/launcher-browser.json'
                descriptor.write_text(json.dumps({'pid': os.getpid(), 'control': {
                    'endpoint': f'http://127.0.0.1:{server.server_port}', 'token': 'test-private-token'}}))
                descriptor.chmod(0o600)
                client = NativeClient(home)
                self.assertTrue(client.available())
                self.assertFalse(client.request('set', {'enabled': False})['enabled'])
                descriptor.chmod(0o644)
                with self.assertRaisesRegex(RuntimeError, 'private'):
                    client.available()
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
