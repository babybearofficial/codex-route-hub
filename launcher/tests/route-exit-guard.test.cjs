const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { restoreOnExit } = require('../electron/route-exit-guard.cjs');

const guardPath = path.resolve(__dirname, '../electron/route-exit-guard.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-guard-'));
  const coreHome = path.join(root, 'core');
  const codexHome = path.join(root, 'codex');
  const leasePath = path.join(coreHome, 'runtime', 'route-exit-guard.json');
  const routePath = path.join(root, 'route.json');
  const callsPath = path.join(root, 'calls.json');
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  fs.mkdirSync(codexHome);
  fs.writeFileSync(routePath, JSON.stringify({ installed: true, active: true, errors: [] }));
  fs.writeFileSync(callsPath, '[]');
  const cliPath = path.join(root, 'cli.cjs');
  fs.writeFileSync(cliPath, `
    const fs = require('node:fs');
    const [routePath, callsPath, noun, action] = process.argv.slice(2);
    const state = JSON.parse(fs.readFileSync(routePath, 'utf8'));
    const calls = JSON.parse(fs.readFileSync(callsPath, 'utf8'));
    calls.push(action); fs.writeFileSync(callsPath, JSON.stringify(calls));
    if (noun !== 'route') process.exit(2);
    if (action === 'disconnect') {
      if (state.errors.length) process.exit(3);
      state.active = false; fs.writeFileSync(routePath, JSON.stringify(state));
      process.stdout.write(JSON.stringify({changed:true,active:false}));
    } else if (action === 'status') process.stdout.write(JSON.stringify(state));
    else process.exit(2);
  `);
  const options = {
    coreHome, codexHome, leasePath, nonce: randomUUID(),
    cliExecutable: process.execPath,
    cliPrefix: [cliPath, routePath, callsPath],
    cwd: root,
  };
  fs.writeFileSync(leasePath, JSON.stringify({ nonce: options.nonce, coreHome, codexHome }));
  return {
    root, options, routePath, callsPath,
    route: () => JSON.parse(fs.readFileSync(routePath, 'utf8')),
    calls: () => JSON.parse(fs.readFileSync(callsPath, 'utf8')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(50);
  }
  throw new Error('Timed out waiting for Route Hub guard result');
}

test('guard restores an owned active route and verifies readback', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await restoreOnExit(f.options), { status: 'restored' });
    assert.equal(f.route().active, false);
    assert.deepEqual(f.calls(), ['status', 'disconnect', 'status']);
    assert.equal(fs.existsSync(f.options.leasePath), false);
  } finally { f.cleanup(); }
});

test('guard refreshes the matching backend after a crash and clears a pending refresh marker', async () => {
  const f = fixture();
  try {
    f.options.clientAppPath = '/Applications/Codex Account.app';
    f.options.clientBundleId = 'local.multicodex.account';
    const markerPath = path.join(f.options.coreHome, 'runtime', 'backend-refresh-pending.json');
    fs.writeFileSync(markerPath, JSON.stringify({ codexHome: f.options.codexHome }));
    const calls = [];
    const result = await restoreOnExit(f.options, { refresh: async options => {
      calls.push(options);
      assert.equal(f.route().active, false);
    } });
    assert.equal(result.status, 'restored');
    assert.deepEqual(calls, [{ appPath: f.options.clientAppPath, bundleId: f.options.clientBundleId }]);
    assert.equal(fs.existsSync(markerPath), false);
  } finally { f.cleanup(); }
});

test('guard completes a backend refresh interrupted after the route file was restored', async () => {
  const f = fixture();
  try {
    f.options.clientAppPath = '/Applications/Codex Account.app';
    f.options.clientBundleId = 'local.multicodex.account';
    fs.writeFileSync(f.routePath, JSON.stringify({ installed: true, active: false, errors: [] }));
    const markerPath = path.join(f.options.coreHome, 'runtime', 'backend-refresh-pending.json');
    fs.writeFileSync(markerPath, JSON.stringify({ codexHome: f.options.codexHome }));
    let refreshed = 0;
    assert.deepEqual(await restoreOnExit(f.options, { refresh: async () => { refreshed += 1; } }),
      { status: 'already-off' });
    assert.equal(refreshed, 1);
    assert.equal(fs.existsSync(markerPath), false);
  } finally { f.cleanup(); }
});

test('guard leaves an already restored route and a newer owner alone', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.routePath, JSON.stringify({ installed: true, active: false, errors: [] }));
    assert.deepEqual(await restoreOnExit(f.options), { status: 'already-off' });
    assert.deepEqual(f.calls(), ['status', 'status']);
    fs.writeFileSync(f.options.leasePath, JSON.stringify({ ...f.options, nonce: randomUUID() }));
    fs.writeFileSync(f.routePath, JSON.stringify({ installed: true, active: true, errors: [] }));
    assert.deepEqual(await restoreOnExit(f.options), { status: 'superseded' });
    assert.equal(f.route().active, true);
  } finally { f.cleanup(); }
});

test('guard refuses an inconsistent route status', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.routePath, JSON.stringify({ installed: true, active: true, errors: ['config changed'] }));
    await assert.rejects(restoreOnExit(f.options, { pause: async () => {} }), /inconsistent status/);
    assert.equal(f.route().active, true);
    assert.equal(fs.existsSync(f.options.leasePath), true);
  } finally { f.cleanup(); }
});

test('a SIGKILLed launcher parent still causes route restoration without touching its client sentinel', async () => {
  if (process.platform === 'win32') return;
  const f = fixture();
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  try {
    const parentScript = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const options = JSON.parse(process.argv[1]);
      const child = spawn(process.execPath, [process.argv[2], JSON.stringify(options)],
        { cwd: options.cwd, detached: true, stdio: ['pipe','pipe','ignore'] });
      child.stdout.once('data', data => {
        if (!String(data).includes('READY')) process.exit(2);
        fs.writeFileSync(process.argv[3], String(child.pid));
        process.kill(process.pid, 'SIGKILL');
      });
    `;
    const pidFile = path.join(f.root, 'guard.pid');
    const parent = spawn(process.execPath, ['-e', parentScript, JSON.stringify(f.options), guardPath, pidFile],
      { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(pidFile));
    await waitFor(() => f.route().active === false);
    await waitFor(() => !fs.existsSync(f.options.leasePath));
    assert.equal(parent.exitCode === null || parent.signalCode === 'SIGKILL', true);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
  } finally {
    sentinel.kill('SIGTERM');
    f.cleanup();
  }
});

test('a SIGKILLed multi-account launcher restores both routes without stopping either client', async () => {
  if (process.platform === 'win32') return;
  const first = fixture();
  const second = fixture();
  const clients = [
    spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' }),
    spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' }),
  ];
  try {
    const parentScript = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const options = JSON.parse(process.argv[1]);
      let ready = 0;
      const pids = [];
      for (const account of options) {
        const child = spawn(process.execPath, [process.argv[2], JSON.stringify(account)],
          { cwd: account.cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
        pids.push(child.pid);
        child.stdout.once('data', data => {
          if (!String(data).includes('READY')) process.exit(2);
          if (++ready === options.length) {
            fs.writeFileSync(process.argv[3], JSON.stringify(pids));
            process.kill(process.pid, 'SIGKILL');
          }
        });
      }
    `;
    const pidFile = path.join(first.root, 'guards.json');
    const parent = spawn(process.execPath, ['-e', parentScript,
      JSON.stringify([first.options, second.options]), guardPath, pidFile], { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(pidFile));
    await waitFor(() => first.route().active === false && second.route().active === false);
    await waitFor(() => !fs.existsSync(first.options.leasePath)
      && !fs.existsSync(second.options.leasePath));
    assert.equal(parent.exitCode === null || parent.signalCode === 'SIGKILL', true);
    assert.deepEqual(first.calls(), ['status', 'disconnect', 'status']);
    assert.deepEqual(second.calls(), ['status', 'disconnect', 'status']);
    for (const client of clients) assert.doesNotThrow(() => process.kill(client.pid, 0));
  } finally {
    for (const client of clients) client.kill('SIGTERM');
    first.cleanup();
    second.cleanup();
  }
});

test('packaged Bun can execute the guard and the route CLI after stdin closes', async t => {
  const bun = process.env.CODEX_WEB_GPT_BUN || process.env.CODEX_CHATGPT_WEB_BUN || 'bun';
  const probe = spawnSync(bun, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (probe.error || probe.status !== 0) return t.skip('No Bun runtime');
  const f = fixture();
  const options = { ...f.options, cliExecutable: bun };
  try {
    const guard = spawn(bun, [guardPath, JSON.stringify(options)],
      { cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    guard.stdout.on('data', data => { stdout += data; });
    guard.stderr.on('data', data => { stderr += data; });
    await waitFor(() => stdout.includes('READY\n'));
    guard.stdin.end();
    await waitFor(() => f.route().active === false);
    await waitFor(() => guard.exitCode !== null);
    assert.equal(guard.exitCode, 0, stderr);
    assert.deepEqual(f.calls(), ['status', 'disconnect', 'status']);
  } finally { f.cleanup(); }
});
