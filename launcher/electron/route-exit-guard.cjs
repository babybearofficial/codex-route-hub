// Runs outside Electron so a hard launcher crash can still restore its owned Codex route.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { refreshCodexBackend } = require('./codex-backend-refresh.cjs');

const READY_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

function validOptions(options) {
  if (!options || typeof options !== 'object'
    || !['leasePath', 'coreHome', 'codexHome', 'cwd'].every(
      key => typeof options[key] === 'string' && path.isAbsolute(options[key]),
    )
    || typeof options.cliExecutable !== 'string'
    || !(path.isAbsolute(options.cliExecutable) || /^[A-Za-z0-9._-]+$/.test(options.cliExecutable))
    || typeof options.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(options.nonce)
    || (options.clientAppPath !== undefined && !path.isAbsolute(options.clientAppPath))
    || (options.clientBundleId !== undefined && !/^[A-Za-z0-9._-]+$/.test(options.clientBundleId))
    || ((options.clientAppPath === undefined) !== (options.clientBundleId === undefined))
    || !Array.isArray(options.cliPrefix)
    || options.cliPrefix.some(part => typeof part !== 'string' || !part)) {
    throw new Error('Route exit guard has invalid startup arguments');
  }
  return options;
}

function appendGuardLog(options, event, detail = '') {
  try {
    const logPath = path.join(options.coreHome, 'logs', 'route-exit-guard.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${event} ${detail.slice(0, 300)}\n`, { mode: 0o600 });
  } catch {}
}

function writeLease(leasePath, lease) {
  const temporary = `${leasePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, leasePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function ownsLease(options) {
  try {
    const lease = JSON.parse(fs.readFileSync(options.leasePath, 'utf8'));
    return lease.nonce === options.nonce
      && lease.coreHome === options.coreHome
      && lease.codexHome === options.codexHome;
  } catch { return false; }
}

function invokeRoute(options, action, run = spawnSync) {
  const result = run(options.cliExecutable, [...options.cliPrefix, 'route', action], {
    cwd: options.cwd,
    env: {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: options.coreHome,
      CODEX_HOME: options.codexHome,
    },
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`route ${action} failed (${result.error?.code || result.status || 'unknown'})`);
  }
  let status;
  try { status = JSON.parse(result.stdout); }
  catch { throw new Error(`route ${action} returned invalid JSON`); }
  if (typeof status?.active !== 'boolean'
    || (action === 'status' && typeof status?.installed !== 'boolean')
    || (status.errors !== undefined && (!Array.isArray(status.errors) || status.errors.length > 0))) {
    throw new Error(`route ${action} returned an inconsistent status`);
  }
  return status;
}

async function restoreOnExit(options, { run = spawnSync, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  refresh = refreshCodexBackend } = {}) {
  validOptions(options);
  const markerPath = path.join(options.coreHome, 'runtime', 'backend-refresh-pending.json');
  let routeWasActive = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!ownsLease(options)) return { status: 'superseded' };
    try {
      const before = invokeRoute(options, 'status', run);
      routeWasActive ||= before.active;
      if (before.active) {
        if (!ownsLease(options)) return { status: 'superseded' };
        const restored = invokeRoute(options, 'disconnect', run);
        if (restored.active) throw new Error('route disconnect remained active');
      }
      const after = invokeRoute(options, 'status', run);
      if (after.active) throw new Error('route status remained active');
      let pending = false;
      if (fs.existsSync(markerPath)) {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (marker.codexHome !== options.codexHome) {
          throw new Error('Backend refresh marker belongs to another Codex home');
        }
        pending = true;
      }
      if (!ownsLease(options)) return { status: 'superseded' };
      if ((routeWasActive || pending) && options.clientAppPath) {
        await refresh({ appPath: options.clientAppPath, bundleId: options.clientBundleId });
        fs.rmSync(markerPath, { force: true });
      }
      // A new launcher may have started while the CLI was running.
      if (!ownsLease(options)) return { status: 'superseded' };
      fs.rmSync(options.leasePath, { force: true });
      return { status: before.active ? 'restored' : 'already-off' };
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1) throw error;
      await pause(500 * (attempt + 1));
    }
  }
}

async function startRouteExitGuard({ coreHome, codexHome, cliInvocation, guardPath, logger, onUnexpectedExit,
  clientAppPath, clientBundleId }) {
  if (!cliInvocation || typeof cliInvocation.executable !== 'string'
    || !Array.isArray(cliInvocation.args) || !path.isAbsolute(guardPath)) {
    throw new Error('Route exit guard needs an installed runtime invocation');
  }
  const leasePath = path.join(coreHome, 'runtime', 'route-exit-guard.json');
  const options = validOptions({
    coreHome, codexHome, leasePath,
    nonce: randomUUID(),
    cliExecutable: cliInvocation.executable,
    cliPrefix: cliInvocation.args,
    cwd: cliInvocation.cwd,
    ...(clientAppPath ? { clientAppPath, clientBundleId } : {}),
  });
  fs.mkdirSync(path.dirname(leasePath), { recursive: true, mode: 0o700 });
  writeLease(leasePath, { nonce: options.nonce, coreHome, codexHome });
  const child = spawn(cliInvocation.executable, [guardPath, JSON.stringify(options)], {
    cwd: cliInvocation.cwd,
    detached: true,
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: coreHome, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-1000); });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Route exit guard did not become ready')), READY_TIMEOUT_MS);
      const done = (error) => {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        error ? reject(error) : resolve();
      };
      const onData = chunk => {
        output = `${output}${chunk}`.slice(-100);
        if (output.includes('READY\n')) done();
      };
      const onError = error => done(error);
      const onExit = (code, signal) => done(new Error(`Route exit guard exited before ready (${signal || code})`));
      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  } catch (error) {
    if (ownsLease(options)) fs.rmSync(leasePath, { force: true });
    child.stdin.destroy();
    throw new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ''}`);
  }
  let released = false;
  child.stdin.on('error', error => {
    if (!released) logger?.error?.('routing.exit_guard_pipe_failed', { message: error.message });
  });
  child.on('error', error => {
    if (!released) logger?.error?.('routing.exit_guard_process_failed', { message: error.message });
  });
  child.once('exit', (code, signal) => {
    if (!released) {
      logger?.error?.('routing.exit_guard_lost', { code, signal });
      onUnexpectedExit?.();
    }
  });
  child.unref();
  child.stdout.unref?.();
  child.stderr.unref?.();
  logger?.info?.('routing.exit_guard_ready', { pid: child.pid });
  return {
    pid: child.pid,
    release() { released = true; child.stdin.end(); },
  };
}

if (require.main === module) {
  let options;
  try {
    options = validOptions(JSON.parse(process.argv[2]));
    process.stdout.write('READY\n');
    process.stdin.resume();
    process.stdin.once('end', () => {
      void restoreOnExit(options).then(result => {
        appendGuardLog(options, result.status);
      }).catch(error => {
        appendGuardLog(options, 'failed', error.message);
        process.exitCode = 1;
      });
    });
  } catch (error) {
    process.stderr.write(`route-exit-guard startup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { invokeRoute, ownsLease, restoreOnExit, startRouteExitGuard };
