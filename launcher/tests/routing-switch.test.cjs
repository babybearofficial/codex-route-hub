const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RoutingSwitch, KEEPER_RECOVERY_BACKOFF_MS, KEEPER_TRANSITION_STALE_MS, KEEPER_UNHEALTHY_STREAK, CATALOG_SYNC_TIMEOUT_MS,
  STARTUP_RETRY_DELAYS_MS } = require('../electron/routing-switch.cjs');

const INSTALLED = 'http://127.0.0.1:17841/v1';
const ORIGINAL_LINE = 'openai_base_url="https://original.example/v1"';
const ROUTE_LINE = `openai_base_url = "${INSTALLED}"`;

// The world mirrors what the TypeScript runtime does to the journal and config so that the
// switch's read-only route check sees realistic evidence.
function world({ client = false, codexRunning = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-switch-'));
  const coreHome = path.join(root, 'web');
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(path.join(coreHome, 'codex'), { recursive: true }); fs.mkdirSync(codexHome);
  const config = path.join(codexHome, 'config.toml');
  const baseline = `model="original"\n${ORIGINAL_LINE}\n`;
  fs.writeFileSync(config, baseline);
  const journal = path.join(coreHome, 'codex/integration-journal.json');
  const state = { routingDisabled: false }; const calls = []; const operations = [];
  let ready = false; let healthy = true; let clock = 1_000_000;
  const health = { service: 'codex-chatgpt-web', status: 'ok', pid: 4242, successful_model_catalog_requests: 0, last_successful_model_catalog_request_at: null };
  const writeJournal = active => fs.writeFileSync(journal, JSON.stringify({ version: 10, active, configPath: config, installed: { openai_base_url: INSTALLED } }));
  const journalActive = () => fs.existsSync(journal) && JSON.parse(fs.readFileSync(journal, 'utf8')).active === true;
  const setRoute = active => {
    const text = fs.readFileSync(config, 'utf8');
    const line = active ? ROUTE_LINE : ORIGINAL_LINE;
    fs.writeFileSync(config, /^openai_base_url\s*=.*$/m.test(text) ? text.replace(/^openai_base_url\s*=.*$/m, line) : `${line}\n${text}`);
  };
  const host = {
    coreHome, codexHome, currentOperation: () => null,
    runtimeConfigSnapshot: () => ({ configured: true, config: { mode: 'full' } }),
    upgradeManagedRuntime: async () => calls.push('upgrade'),
    bridgeStatus: async () => ({ installed: fs.existsSync(journal), active: journalActive() }),
    setupCore: async () => { calls.push('setup'); writeJournal(false); },
    connectBridgeRoute: async () => {
      calls.push('connect');
      const changed = !journalActive();
      writeJournal(true); setRoute(true);
      return { changed };
    },
    restoreBridgeRoute: async () => {
      calls.push('restore');
      const changed = journalActive();
      if (fs.existsSync(journal)) writeJournal(false);
      setRoute(false);
      return { active: false, changed };
    },
    doctor: async () => ({ ok: true, checks: [{ id: 'tunnel', status: 'ok', message: 'ready' }] }),
  };
  const supervisor = {
    readState: () => ({ status: ready ? 'ready' : 'stopped', daemonPid: ready ? 4242 : null }),
    readConfig: () => ({ host: '127.0.0.1', port: 17841 }),
    proxyHealthPayload: async () => (ready && healthy ? { ...health } : null),
    startIfConfigured: async () => { calls.push('start'); ready = true; return { status: 'ready' }; },
    stopForSetup: async () => { calls.push('stop'); ready = false; },
    probeNow: () => { calls.push('probe'); },
  };
  const codex = {
    running: codexRunning, previous: null,
    stop: async () => {
      calls.push('quit-client');
      codex.previous = codex.running ? { pid: 1 } : null;
      const wasRunning = codex.running; codex.running = false;
      return { wasRunning };
    },
    reopen: async ({ recovery = false } = {}) => {
      if (recovery && !codex.previous) return { reopened: false };
      calls.push('open-client'); codex.running = true; codex.previous = null;
      return { reopened: true };
    },
  };
  const restarted = [];
  const control = new RoutingSwitch({ host, supervisor, client: client ? codex : null,
    store: { read: () => ({ ...state }), update: patch => Object.assign(state, patch) },
    publishOperation: operation => operations.push(operation),
    onClientRestarted: baseline => restarted.push(baseline),
    logger: { info() {}, warn() {}, error() {} },
    now: () => clock, pause: async ms => { clock += ms; }, resumeSettleMs: 5 });
  return { control, host, supervisor, codex, state, calls, operations, restarted, config, journal, baseline, health,
    routeActive: () => new RegExp(`^${ROUTE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(fs.readFileSync(config, 'utf8')),
    isReady: () => ready, setReady: value => { ready = value; }, setHealthy: value => { healthy = value; },
    advance: ms => { clock += ms; }, writeJournal, setRoute,
    cleanup: () => { control.stopKeeper(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('enable verifies readiness and off restores before retiring the journal', async () => {
  const w = world();
  try {
    assert.equal((await w.control.setEnabled(true)).last.ok, true);
    assert.equal(w.routeActive(), true);
    assert.equal(w.control.status().routeActive, true);
    assert.equal((await w.control.setEnabled(false)).last.status, 'off');
    assert.deepEqual(w.calls.slice(-2), ['stop', 'restore']);
    assert.equal(fs.readFileSync(w.config, 'utf8'), w.baseline);
    assert.equal(fs.existsSync(w.journal), false);
    assert.equal(w.state.routingDisabled, true);
    assert.equal(w.control.status().routeActive, false);
    assert.equal(w.control.keeperTimer, null);
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
    assert.equal(w.routeActive(), false);
  } finally { w.cleanup(); }
});

test('a browser-only doctor failure keeps a healthy route and runtime supervised', async () => {
  const w = world({ client: true });
  try {
    w.host.doctor = async () => ({
      ok: false,
      checks: [
        { id: 'browser-host', status: 'error', message: 'Embedded launcher browser is unavailable' },
        { id: 'proxy', status: 'ok', message: 'Responses proxy is healthy' },
        { id: 'tunnel-runtime', status: 'ok', message: 'Tunnel runtime reports healthy and ready' },
      ],
    });
    const result = await w.control.setEnabled(true);
    assert.equal(result.last.ok, true);
    assert.equal(result.last.status, 'degraded');
    assert.equal(w.state.routingDisabled, false);
    assert.equal(w.routeActive(), true);
    assert.equal(w.isReady(), true);
    assert.ok(!w.calls.includes('restore'), 'a healthy local route must not be rolled back');
    assert.equal(w.codex.running, true, 'Codex is reopened on the still-active route');
    assert.notEqual(w.control.keeperTimer, null);
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
    const text = fs.readFileSync(w.config, 'utf8');
    assert.match(text, /model="changed-while-off"/);
    assert.ok(text.includes(ROUTE_LINE));
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
      assert.equal(w.control.keeperTimer, null);
    }
    assert.equal(w.calls.filter(c => c === 'setup').length, 1);
  } finally { w.cleanup(); }
});

test('restore failure keeps the runtime serving the still-routed config and retains the journal', async () => {
  const w = world({ client: true });
  try {
    await w.control.setEnabled(true);
    w.host.restoreBridgeRoute = async () => { throw new Error('conflicting user change'); };
    await assert.rejects(w.control.setEnabled(false), /conflicting user change/);
    assert.equal(fs.existsSync(w.journal), true);
    assert.equal(w.control.inFlight, null);
    // Off remains the saved intent, but Codex still reads the managed route, so the proxy is
    // brought back and the keeper protects it until off can finish.
    assert.equal(w.state.routingDisabled, true);
    assert.equal(w.isReady(), true);
    assert.equal(w.codex.running, true);
    const status = w.control.status();
    assert.equal(status.enabled, false);
    assert.equal(status.routeActive, true);
    assert.equal(status.last.status, 'failed');
    assert.notEqual(w.control.keeperTimer, null);
  } finally { w.cleanup(); }
});

test('pipeline verifies authentication, quits client, establishes route then reopens client', async () => {
  const w = world({ client: true });
  w.control.preflight = async () => w.calls.push('auth');
  try {
    await w.control.setEnabled(true);
    assert.ok(w.calls.indexOf('auth') < w.calls.indexOf('quit-client'));
    assert.ok(w.calls.indexOf('quit-client') < w.calls.indexOf('start'));
    assert.ok(w.calls.indexOf('connect') < w.calls.indexOf('open-client'));
    assert.equal(w.control.last.clientRestarted, true);
    assert.equal(w.restarted.length, 1);
    assert.equal(w.state.codexCatalogVerified, false);
    assert.equal(w.state.codexRestartRequired, false);
  } finally { w.cleanup(); }
});

test('pipeline failure restores original route before reopening the previous client', async () => {
  const w = world({ client: true });
  w.host.doctor = async () => { throw new Error('unhealthy'); };
  try {
    await assert.rejects(w.control.setEnabled(true), /unhealthy/);
    assert.deepEqual(w.calls.slice(-3), ['stop', 'restore', 'open-client']);
    assert.equal(w.routeActive(), false);
    assert.equal(w.codex.running, true);
  } finally { w.cleanup(); }
});

test('authentication failure does not quit the client and changes nothing but the saved intent', async () => {
  const w = world({ client: true });
  try {
    w.state.routingDisabled = true;
    w.control.preflight = async () => { throw new Error('ERR_CONNECTION_CLOSED'); };
    await assert.rejects(w.control.setEnabled(true), /ERR_CONNECTION_CLOSED/);
    assert.ok(!w.calls.includes('quit-client'));
    assert.ok(!w.calls.includes('stop') && !w.calls.includes('restore'));
    assert.equal(w.state.routingDisabled, true, 'the previous off intent is put back');

    // Routing already in effect: a failed preflight during a refresh keeps it in effect.
    w.control.preflight = async () => {};
    await w.control.setEnabled(true);
    const before = w.calls.length;
    w.control.preflight = async () => { throw new Error('ERR_CONNECTION_RESET'); };
    await assert.rejects(w.control.setEnabled(true), /ERR_CONNECTION_RESET/);
    assert.deepEqual(w.calls.slice(before), []);
    assert.equal(w.state.routingDisabled, false);
    assert.equal(w.isReady(), true);
    assert.equal(w.routeActive(), true);
    assert.notEqual(w.control.keeperTimer, null);
  } finally { w.cleanup(); }
});

test('a declined Codex quit during an explicit start never tears down a route Codex still reads', async () => {
  const w = world({ client: true });
  try {
    await w.control.setEnabled(true);
    // Interrupted off: intent off, route active, runtime serving it.
    w.state.routingDisabled = true;
    w.codex.stop = async () => { throw new Error('Codex declined to quit; finish or save the active task and retry'); };
    const before = w.calls.length;
    await assert.rejects(w.control.setEnabled(true), /declined to quit/);
    assert.deepEqual(w.calls.slice(before), []);
    assert.equal(w.isReady(), true, 'the proxy Codex points at keeps running');
    assert.equal(w.routeActive(), true);
    assert.equal(w.state.routingDisabled, true);
    assert.notEqual(w.control.keeperTimer, null);
  } finally { w.cleanup(); }
});

test('off quits Codex first, restores the original connection, then reopens Codex only if it was running', async () => {
  const w = world({ client: true });
  try {
    await w.control.setEnabled(true);
    const before = w.calls.length;
    const result = await w.control.setEnabled(false);
    assert.deepEqual(w.calls.slice(before), ['quit-client', 'stop', 'restore', 'open-client']);
    assert.equal(result.last.status, 'off');
    assert.equal(result.last.clientRestarted, true);
    assert.equal(w.state.codexRestartRequired, false);
    assert.equal(fs.readFileSync(w.config, 'utf8'), w.baseline);
    assert.equal(w.codex.running, true);

    await w.control.setEnabled(true);
    w.codex.running = false;
    const again = w.calls.length;
    await w.control.setEnabled(false);
    assert.deepEqual(w.calls.slice(again), ['quit-client', 'stop', 'restore']);
    assert.equal(w.codex.running, false, 'a Codex that was not open is not launched by off');
  } finally { w.cleanup(); }
});

test('off does not touch Codex when the route is already inactive', async () => {
  const w = world({ client: true });
  try {
    await w.control.setEnabled(true); await w.control.setEnabled(false);
    const before = w.calls.length;
    await w.control.setEnabled(false);
    assert.ok(!w.calls.slice(before).includes('quit-client'));
    assert.ok(!w.calls.slice(before).includes('open-client'));
  } finally { w.cleanup(); }
});

test('off leaves everything untouched when Codex declines to quit', async () => {
  const w = world({ client: true });
  try {
    await w.control.setEnabled(true);
    w.codex.stop = async () => { throw new Error('Codex declined to quit; finish or save the active task and retry'); };
    const before = w.calls.length;
    await assert.rejects(w.control.setEnabled(false), /declined to quit/);
    assert.ok(!w.calls.slice(before).some(call => call === 'stop' || call === 'restore'));
    assert.equal(w.isReady(), true);
    assert.equal(w.routeActive(), true);
    const status = w.control.status();
    assert.equal(status.enabled, false, 'off remains the saved intent');
    assert.equal(status.routeActive, true, 'the UI must show that the route is still in effect');
    assert.equal(status.runtimeReady, true);
    assert.notEqual(w.control.keeperTimer, null, 'the keeper protects the still-routed proxy');
  } finally { w.cleanup(); }
});

test('off reopens Codex and keeps the runtime when the drain is refused', async () => {
  const w = world({ client: true });
  try {
    await w.control.setEnabled(true);
    w.supervisor.stopForSetup = async () => { w.calls.push('stop'); throw new Error('daemon has 1 active HTTP turn(s)'); };
    await assert.rejects(w.control.setEnabled(false), /active HTTP turn/);
    assert.deepEqual(w.calls.slice(-3), ['quit-client', 'stop', 'open-client']);
    assert.equal(w.isReady(), true);
    assert.equal(w.routeActive(), true);
    assert.equal(w.codex.running, true);
  } finally { w.cleanup(); }
});

test('startup keeps a route that is already in effect without restarting Codex', async () => {
  const w = world({ client: true });
  try {
    await w.control.setEnabled(true);
    w.setReady(false); w.control.stopKeeper();
    const before = w.calls.length;
    const result = await w.control.startup();
    const since = w.calls.slice(before);
    assert.ok(since.includes('start'));
    assert.ok(!since.includes('quit-client'));
    assert.ok(!since.includes('open-client'));
    assert.equal(result.last.ok, true);
    assert.equal(result.last.clientRestarted, false);
    assert.equal(result.runtimeReady, true);
    assert.notEqual(w.control.keeperTimer, null);
  } finally { w.cleanup(); }
});

test('startup restarts Codex when the route must change and finishes an interrupted off', async () => {
  const w = world({ client: true });
  try {
    // On intent with no route in the config: Codex has to re-read the new route.
    await w.control.startup();
    assert.ok(w.calls.includes('quit-client') && w.calls.includes('open-client'));
    assert.equal(w.routeActive(), true);

    // Off intent recorded, but the route was left active (crash or refused drain).
    w.state.routingDisabled = true; w.control.stopKeeper();
    const before = w.calls.length;
    const result = await w.control.startup();
    assert.deepEqual(w.calls.slice(before), ['quit-client', 'stop', 'restore', 'open-client']);
    assert.equal(result.last.status, 'off');
    assert.equal(w.routeActive(), false);
    assert.equal(fs.readFileSync(w.config, 'utf8'), w.baseline);
  } finally { w.cleanup(); }
});

test('startup tolerates a Codex that refuses to quit and flags the pending restart', async () => {
  const w = world({ client: true });
  try {
    w.codex.stop = async () => { throw new Error('Codex declined to quit'); };
    const result = await w.control.startup();
    assert.equal(result.last.ok, true);
    assert.equal(result.last.clientRestarted, false);
    assert.match(result.last.message, /Codex 未重启/);
    assert.equal(w.routeActive(), true);
    assert.equal(w.state.codexRestartRequired, true);
    assert.equal(w.state.routingDisabled, false);
  } finally { w.cleanup(); }
});

test('startup retries a sign-in check that failed before anything changed, within bounds', async () => {
  const w = world({ client: true });
  try {
    let failures = 2;
    w.control.preflight = async () => { if (failures-- > 0) throw new Error('ERR_NETWORK_CHANGED'); w.calls.push('auth'); };
    const started = w.control.now();
    const result = await w.control.startup();
    assert.equal(result.last.ok, true);
    assert.equal(w.calls.filter(call => call === 'auth').length, 1);
    assert.equal(w.control.now() - started, STARTUP_RETRY_DELAYS_MS[0] + STARTUP_RETRY_DELAYS_MS[1]);
    assert.ok(!w.calls.includes('restore'), 'no rollback for failures that changed nothing');

    // Bounded: after the last delay the failure surfaces, and routing stays a saved on intent.
    await w.control.setEnabled(false);
    w.state.routingDisabled = false; w.control.stopKeeper();
    w.control.preflight = async () => { throw new Error('ERR_CONNECTION_CLOSED'); };
    const before = w.control.now();
    await assert.rejects(w.control.startup(), /ERR_CONNECTION_CLOSED/);
    assert.equal(w.control.now() - before, STARTUP_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0));
    assert.equal(w.state.routingDisabled, false);

    // A failure after the client stage is not retried; it is rolled back like any other.
    w.control.preflight = async () => {};
    w.host.doctor = async () => ({ ok: false, checks: [{ status: 'error', message: 'tunnel not ready' }] });
    const doctorAt = w.control.now();
    await assert.rejects(w.control.startup(), /tunnel not ready/);
    assert.equal(w.control.now(), doctorAt);
    assert.equal(w.state.routingDisabled, true);
  } finally { w.cleanup(); }
});

test('a failed refresh of an already effective route does not switch routing off', async () => {
  const w = world({ client: true });
  try {
    await w.control.setEnabled(true);
    w.supervisor.startIfConfigured = async () => { w.calls.push('start'); return { status: 'failed', detail: 'tunnel refused' }; };
    await assert.rejects(w.control.setEnabled(true), /tunnel refused/);
    assert.equal(w.state.routingDisabled, false);
    assert.equal(w.routeActive(), true);
    assert.equal(w.codex.running, true, 'the quit Codex is reopened');
    assert.ok(!w.calls.includes('restore'));
    assert.notEqual(w.control.keeperTimer, null, 'the keeper keeps retrying the runtime');
  } finally { w.cleanup(); }
});

test('keeper recovers a failed runtime with bounded backoff and resets after success', async () => {
  const w = world();
  try {
    await w.control.setEnabled(true);
    assert.notEqual(w.control.keeperTimer, null);
    // The proxy stopped answering and the supervisor gave up on its crash-loop budget.
    w.setReady(false);
    w.supervisor.readState = () => ({ status: 'failed', daemonPid: null, detail: 'daemon stopped more than 5 times' });
    let attempts = 0;
    w.supervisor.startIfConfigured = async () => { attempts += 1; if (attempts < 3) return { status: 'failed', detail: 'still down' }; w.setReady(true); w.supervisor.readState = () => ({ status: 'ready', daemonPid: 4242 }); return { status: 'ready' }; };
    await w.control.keep('test');
    assert.equal(attempts, 1);
    await w.control.keep('test');
    assert.equal(attempts, 1, 'no retry inside the backoff window');
    w.advance(KEEPER_RECOVERY_BACKOFF_MS[0]);
    await w.control.keep('test');
    assert.equal(attempts, 2);
    assert.equal(w.control.recovery.attempts, 2);
    w.advance(KEEPER_RECOVERY_BACKOFF_MS[1]);
    await w.control.keep('test');
    assert.equal(attempts, 3);
    assert.deepEqual(w.control.recovery, { attempts: 0, nextAt: 0 });
    assert.equal(w.control.status().runtimeReady, true);
    assert.equal(w.operations.at(-1).status, 'completed');
    assert.equal(w.control.keeping, null);
  } finally { w.cleanup(); }
});

test('keeper defers to the supervisor for fresh transitions and unrecoverable states, acts on stalled ones', async () => {
  const w = world();
  try {
    await w.control.setEnabled(true);
    const starts = () => w.calls.filter(call => call === 'start').length;
    const baseline = starts();
    // Ready ownership state but a proxy that stopped answering: give the daemon monitor a chance.
    w.setHealthy(false);
    for (let i = 1; i < KEEPER_UNHEALTHY_STREAK; i++) { await w.control.keep('test'); assert.equal(starts(), baseline); }
    await w.control.keep('test');
    assert.equal(starts(), baseline + 1);
    assert.equal(w.control.status().runtimeReady, false, 'a failing proxy is not reported as ready');
    w.setHealthy(true); w.control.recovery = { attempts: 0, nextAt: 0 };
    await w.control.keep('test');
    assert.equal(w.control.unhealthyStreak, 0);
    // Fresh supervisor transition: hands off.
    w.setReady(false);
    const transitionAt = new Date(w.control.now()).toISOString();
    w.supervisor.readState = () => ({ status: 'degraded', daemonPid: null, updatedAt: transitionAt });
    await w.control.keep('test');
    assert.equal(starts(), baseline + 1);
    // The same transition, stalled for longer than the supervisor could plausibly need.
    w.advance(KEEPER_TRANSITION_STALE_MS + 1);
    await w.control.keep('test');
    assert.equal(starts(), baseline + 2);
    // States that need the user are reported, not retried.
    w.setReady(false); w.control.recovery = { attempts: 0, nextAt: 0 };
    for (const status of ['needs-setup', 'external', 'not-configured']) {
      w.supervisor.readState = () => ({ status, daemonPid: null, updatedAt: new Date(0).toISOString() });
      await w.control.keep('test');
      assert.equal(starts(), baseline + 2, `${status} is not recoverable by restarting`);
    }
  } finally { w.cleanup(); }
});

test('keeper is idle while off with no route, skips busy operations and never edits the config', async () => {
  const w = world();
  try {
    w.state.routingDisabled = true;
    assert.equal(await w.control.keep('test'), null);
    assert.equal(w.control.keeperTimer, null);
    await w.control.setEnabled(true); await w.control.setEnabled(false);
    w.control.startKeeper();
    assert.equal(await w.control.keep('test'), null);
    assert.equal(w.control.keeperTimer, null, 'a keeper that is not wanted stops itself');
    assert.ok(!w.calls.includes('probe'));

    await w.control.setEnabled(true);
    const before = w.calls.length;
    const pending = w.control.setEnabled(false);
    assert.equal(await w.control.keep('test'), null, 'in-flight operations own the runtime');
    await pending;
    // A route removed by the user while enabled is reported, not silently re-installed.
    w.state.routingDisabled = false; w.setReady(true);
    w.supervisor.readState = () => ({ status: 'ready', daemonPid: 4242 });
    const observed = await w.control.keep('test');
    assert.equal(observed.routeActive, false);
    assert.ok(!w.calls.slice(before).includes('connect'));
    assert.equal(w.control.status().routeActive, false);
  } finally { w.cleanup(); }
});

test('keeper keeps the proxy alive whenever Codex still reads the managed route', async () => {
  const w = world();
  try {
    await w.control.setEnabled(true);
    // Simulate an off whose restore never happened: intent off, route still active, runtime down.
    w.state.routingDisabled = true; w.setReady(false);
    const before = w.calls.length;
    const observed = await w.control.keep('test');
    assert.ok(w.calls.slice(before).includes('start'));
    assert.equal(observed.proxyHealthy, true);
  } finally { w.cleanup(); }
});

test('system resume probes the owned children now and re-observes after settling', async () => {
  const w = world();
  let sessionRefreshes = 0;
  w.control.refreshSession = async () => { sessionRefreshes += 1; if (sessionRefreshes === 1) throw new Error('ChatGPT browser is running Codex turn abc'); };
  try {
    await w.control.setEnabled(true);
    await w.control.keep('interval');
    assert.equal(sessionRefreshes, 0, 'interval ticks do not touch the browser session');
    w.setReady(false);
    w.supervisor.readState = () => ({ status: 'failed', daemonPid: null });
    w.control.onSystemResume();
    w.control.onSystemResume();
    assert.equal(w.calls.filter(call => call === 'probe').length, 2);
    await new Promise(resolve => setTimeout(resolve, 40));
    await w.control.keeping;
    assert.equal(w.control.resumeTimer, null);
    assert.equal(sessionRefreshes, 1, 'a refused session refresh is reported, not fatal');
    assert.equal(w.isReady(), true, 'one settled re-observation recovered the runtime');
    w.control.onSystemResume({ event: 'unlock-screen' });
    await new Promise(resolve => setTimeout(resolve, 40));
    await w.control.keeping;
    assert.equal(sessionRefreshes, 1, 'a screen unlock does not touch the browser session');
    w.control.onSystemResume();
    w.control.stopKeeper();
    assert.equal(w.control.resumeTimer, null);
  } finally { w.cleanup(); }
});

test('catalog evidence counts only requests newer than the controlled Codex restart', async () => {
  const w = world({ client: true });
  try {
    w.health.successful_model_catalog_requests = 137;
    w.health.last_successful_model_catalog_request_at = new Date(500_000).toISOString();
    await w.control.setEnabled(true);
    assert.deepEqual(w.restarted[0], { requests: 137, atMs: w.control.catalogBaseline.atMs });
    assert.equal(w.state.codexCatalogVerified, false);
    await w.control.keep('test');
    assert.equal(w.state.codexCatalogVerified, false, 'old cumulative requests are not evidence');
    w.health.successful_model_catalog_requests = 138;
    await w.control.keep('test');
    assert.equal(w.state.codexCatalogVerified, true);
    assert.equal(w.state.codexRestartRequired, false);
    assert.equal(w.control.status().catalogVerified, true);
  } finally { w.cleanup(); }
});

test('sync restarts Codex and reports only an observed catalog request as success', async () => {
  const w = world({ client: true });
  try {
    w.state.routingDisabled = true;
    await assert.rejects(w.control.sync(), /先启动路由/);
    await w.control.setEnabled(true);
    w.health.successful_model_catalog_requests = 10;
    const before = w.calls.length;
    let observations = 0;
    const payload = w.supervisor.proxyHealthPayload;
    w.supervisor.proxyHealthPayload = async () => { observations += 1; if (observations >= 4) w.health.successful_model_catalog_requests = 11; return payload(); };
    const result = await w.control.sync();
    assert.deepEqual(w.calls.slice(before), ['quit-client', 'open-client']);
    assert.equal(result.last.status, 'synced');
    assert.equal(result.catalogVerified, true);
    assert.equal(w.restarted.length, 2);

    // No request within the bounded wait: honest partial result, verification continues later.
    w.supervisor.proxyHealthPayload = payload;
    const started = w.control.now();
    const later = await w.control.sync();
    assert.equal(later.last.status, 'restarted');
    assert.ok(w.control.now() - started >= CATALOG_SYNC_TIMEOUT_MS);
    assert.equal(w.state.codexCatalogVerified, false);
  } finally { w.cleanup(); }
});

test('sync refuses to proceed when Codex declines to quit or the route is not in effect', async () => {
  const w = world({ client: true });
  try {
    await w.control.setEnabled(true);
    w.codex.stop = async () => { throw new Error('Codex declined to quit'); };
    const before = w.calls.length;
    await assert.rejects(w.control.sync(), /declined to quit/);
    assert.ok(!w.calls.slice(before).includes('open-client'));
    w.setRoute(false);
    await assert.rejects(w.control.sync(), /未指向本地代理/);
    assert.equal(w.control.inFlight, null);
  } finally { w.cleanup(); }
});

test('sync without a client controller recovers the runtime and asks for a manual restart', async () => {
  const w = world();
  try {
    await w.control.setEnabled(true);
    w.setReady(false);
    const result = await w.control.sync();
    assert.equal(result.last.status, 'restart-required');
    assert.equal(w.isReady(), true);
    assert.equal(w.state.codexRestartRequired, true);
  } finally { w.cleanup(); }
});

test('catalog verification is cleared when the listener or route is lost', () => {
  const w = world();
  try {
    const observed = { proxyHealthy: true, routeActive: true, catalogRequests: 1, lastCatalogAtMs: 1 };
    assert.equal(w.control.verifyCatalog(observed), true);
    assert.equal(w.state.codexCatalogVerified, true);
    assert.equal(w.control.verifyCatalog({ ...observed, proxyHealthy: false }), false);
    assert.equal(w.state.codexCatalogVerified, false);
    assert.equal(w.control.verifyCatalog(observed), true);
    assert.equal(w.control.verifyCatalog({ ...observed, routeActive: false }), false);
    assert.equal(w.state.codexCatalogVerified, false);
  } finally { w.cleanup(); }
});
