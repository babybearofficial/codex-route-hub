const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RoutingSwitch } = require('../electron/routing-switch.cjs');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-switch-'));
  const coreHome = path.join(root, 'web');
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(path.join(coreHome, 'codex'), { recursive: true }); fs.mkdirSync(codexHome);
  const config = path.join(codexHome, 'config.toml');
  const baseline = 'model="original"\nopenai_base_url="https://original.example/v1"\n';
  fs.writeFileSync(config, baseline);
  const journal = path.join(coreHome, 'codex/integration-journal.json');
  const state = { routingDisabled: false }; const calls = [];
  let active = false; let ready = false;
  const host = {
    coreHome, codexHome, currentOperation: () => null,
    runtimeConfigSnapshot: () => ({ configured: true, config: { mode: 'full' } }),
    upgradeManagedRuntime: async () => calls.push('upgrade'),
    bridgeStatus: async () => ({ installed: fs.existsSync(journal), active }),
    setupCore: async () => { calls.push('setup'); fs.writeFileSync(journal, JSON.stringify({ active: false, configPath: config })); },
    connectBridgeRoute: async () => { calls.push('connect'); active = true; return { changed: true }; },
    restoreBridgeRoute: async () => {
      calls.push('restore'); active = false;
      if (fs.existsSync(journal)) fs.writeFileSync(journal, JSON.stringify({ active: false, configPath: config }));
      return { active: false, changed: true };
    },
    doctor: async () => ({ ok: true, checks: [{ id: 'tunnel', status: 'ok', message: 'ready' }] }),
  };
  const supervisor = {
    readState: () => ({ status: ready ? 'ready' : 'stopped' }),
    startIfConfigured: async () => { calls.push('start'); ready = true; return { status: 'ready' }; },
    stopForSetup: async () => { calls.push('stop'); ready = false; },
  };
  const control = new RoutingSwitch({ host, supervisor,
    store: { read: () => ({ ...state }), update: patch => Object.assign(state, patch) } });
  return { control, host, supervisor, state, calls, config, journal, baseline,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('enable verifies readiness and off restores before retiring the journal', async () => {
  const w = world();
  try {
    assert.equal((await w.control.setEnabled(true)).last.ok, true);
    assert.equal((await w.control.setEnabled(false)).last.status, 'off');
    assert.deepEqual(w.calls.slice(-2), ['stop', 'restore']);
    assert.equal(fs.readFileSync(w.config, 'utf8'), w.baseline);
    assert.equal(fs.existsSync(w.journal), false);
    assert.equal(w.state.routingDisabled, true);
  } finally { w.cleanup(); }
});

test('failed doctor rolls back and preserves the explicit off intent', async () => {
  const w = world();
  try {
    w.host.doctor = async () => ({ ok: false, checks: [{ status: 'error', message: 'tunnel not ready' }] });
    await assert.rejects(w.control.setEnabled(true), /tunnel not ready/);
    assert.equal(w.control.inFlight, null);
    assert.equal(w.state.routingDisabled, true);
    assert.deepEqual(w.calls.slice(-2), ['stop', 'restore']);
  } finally { w.cleanup(); }
});

test('off intent survives startup and changed baseline is not overwritten', async () => {
  const w = world();
  try {
    await w.control.setEnabled(true); await w.control.setEnabled(false);
    const count = w.calls.length;
    await w.control.startup(); assert.equal(w.calls.length, count);
    fs.writeFileSync(w.config, 'model="changed-while-off"\n');
    w.control.restoreCheckpoint(); assert.equal(fs.existsSync(w.journal), false);
    await w.control.setEnabled(true);
    assert.equal(fs.readFileSync(w.config, 'utf8'), 'model="changed-while-off"\n');
  } finally { w.cleanup(); }
});

test('one operation only, no promise accumulation over repeated cycles', async () => {
  const w = world();
  try {
    for (let i = 0; i < 50; i++) {
      const pending = w.control.setEnabled(true);
      await assert.rejects(w.control.setEnabled(false), /already running/);
      await pending; await w.control.setEnabled(false);
      assert.equal(w.control.inFlight, null);
    }
    assert.equal(w.calls.filter(c => c === 'setup').length, 1);
  } finally { w.cleanup(); }
});

test('restore failure retains recovery journal and never reports off success', async () => {
  const w = world();
  try {
    await w.control.setEnabled(true);
    w.host.restoreBridgeRoute = async () => { throw new Error('conflicting user change'); };
    await assert.rejects(w.control.setEnabled(false), /conflicting user change/);
    assert.equal(fs.existsSync(w.journal), true);
    assert.equal(w.control.inFlight, null);
  } finally { w.cleanup(); }
});
