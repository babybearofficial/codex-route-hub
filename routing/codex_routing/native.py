"""Authenticated client for the merged launcher's single lifecycle owner."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .controller import SyncResult
from .decide import Action


class NativeClient:
    def __init__(self, home: Path):
        self.home = home
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, action: str, payload=None, timeout=3):
        descriptor = self.home / 'runtime/launcher-browser.json'
        stat = descriptor.stat()
        if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
            raise RuntimeError('Launcher descriptor must be private and owned by this user')
        data = json.loads(descriptor.read_text())
        os.kill(data['pid'], 0)
        control = data['control']
        endpoint = urllib.parse.urlsplit(control['endpoint'])
        if endpoint.scheme != 'http' or endpoint.hostname not in {'127.0.0.1', 'localhost', '::1'}:
            raise RuntimeError('Launcher control endpoint must be loopback HTTP')
        request = urllib.request.Request(control['endpoint'] + '/v1/routing/' + action,
            data=json.dumps(payload or {}).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise RuntimeError(json.load(exc).get('error', 'Native routing operation failed')) from None

    def available(self):
        try:
            status = self.request('status')
            return bool(status and status.get('protocol') == 'codex-routing-v1')
        except (OSError, ValueError, KeyError):
            return False


class NativeAwareController:
    """Use native ownership when available; old installed launchers retain compatibility."""
    def __init__(self, legacy, client: NativeClient):
        self.legacy = legacy
        self.client = client
        self.intent = legacy.intent
        self.probe = legacy.probe

    @property
    def progress(self):
        return self.legacy.progress

    @progress.setter
    def progress(self, value):
        self.legacy.progress = value

    def enable(self, **kwargs):
        integrated = (self.client.home / 'runtime/routing-control.json').exists()
        if integrated and not self.client.available():
            self.progress('正在后台启动整合后的 Web GPT 控制器…')
            self.legacy.app.start()
            deadline = time.monotonic() + 40
            while not self.client.available():
                if time.monotonic() >= deadline:
                    return SyncResult(Action.NONE, self.probe(), 'Integrated routing API did not start; no parallel controller was launched')
                time.sleep(.25)
        if not integrated and not self.client.available():
            return self.legacy.enable(**kwargs)
        self.progress('由整合后的 Web GPT 启动器统一开启并验证运行时…')
        self.intent.mark_on()
        try:
            result = self.client.request('set', {'enabled': True}, timeout=660)
            if not result or not result.get('runtimeReady') or not result.get('last', {}).get('ok'):
                raise RuntimeError('Native runtime did not verify ready')
            return SyncResult(Action.CONNECT, self.probe())
        except Exception as exc:
            return SyncResult(Action.NONE, self.probe(), str(exc))

    def disable(self):
        if not self.client.available():
            return self.legacy.disable()
        self.intent.mark_off()
        self.progress('由整合后的 Web GPT 启动器停止运行时并恢复开启前配置…')
        try:
            result = self.client.request('set', {'enabled': False}, timeout=660)
            if not result or result.get('enabled') or not result.get('last', {}).get('ok'):
                raise RuntimeError('Native route restoration did not verify')
            return SyncResult(Action.DISCONNECT, self.probe())
        except Exception as exc:
            return SyncResult(Action.DISCONNECT, self.probe(), str(exc))

    def sync(self, **kwargs):
        if self.client.available():
            # The native supervisor owns recovery and explicit user-off state.
            return SyncResult(Action.NONE, self.probe())
        return self.legacy.sync(**kwargs)
