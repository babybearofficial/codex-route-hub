const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writePrivateFileAtomic } = require('./atomic-file.cjs');
const { redactText } = require('./logging.cjs');

// The keeper observes the owned runtime while a route is in effect and converges it back to
// ready with bounded, backed-off recovery attempts. It never edits the Codex configuration.
const KEEPER_INTERVAL_MS = 15_000;
const KEEPER_RECOVERY_BACKOFF_MS = Object.freeze([30_000, 60_000, 120_000, 300_000]);
const RESUME_SETTLE_MS = 5_000;
const CATALOG_SYNC_TIMEOUT_MS = 60_000;
const CATALOG_SYNC_POLL_MS = 1_000;
// A transition older than this is a stuck state, not supervisor work in progress.
const KEEPER_TRANSITION_STALE_MS = 3 * 60_000;
// A ready runtime whose proxy stops answering gets this many keeper ticks for the supervisor's
// own daemon monitor to act first.
const KEEPER_UNHEALTHY_STREAK = 2;
// Login-time starts often run before the network is up; a start that failed before touching
// anything (sign-in check, readiness barrier) is retried a bounded number of times.
const STARTUP_RETRY_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000]);
const RUNTIME_TRANSITION_STATUSES = new Set(['starting', 'stopping', 'degraded', 'draining']);
// These need the user (setup, another owner), not another start attempt.
const RUNTIME_UNRECOVERABLE_STATUSES = new Set(['needs-setup', 'external', 'not-configured']);

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = error => redactText(error instanceof Error ? error.message : String(error));

function browserOnlyDoctorFailure(report) {
  if (report?.ok !== false || !Array.isArray(report.checks)) return false;
  const failures = report.checks.filter(check => check?.status === 'error');
  return failures.length > 0 && failures.every(check => check?.id === 'browser-host');
}

class RoutingSwitch {
  constructor({ host, supervisor, store, publishState, publishOperation, ready = async () => {}, preflight = async () => {},
    client = null, logger = null, onClientRestarted = null, refreshSession = null, now = Date.now, pause = sleep,
    keeperIntervalMs = KEEPER_INTERVAL_MS, resumeSettleMs = RESUME_SETTLE_MS }) {
    Object.assign(this, { host, supervisor, store, publishState, publishOperation, ready, preflight, client, logger,
      onClientRestarted, refreshSession, now, pause, keeperIntervalMs, resumeSettleMs });
    this.inFlight = null;
    this.last = null;
    this.keeperTimer = null;
    this.keeping = null;
    this.resumeTimer = null;
    this.observation = null;
    this.unhealthyStreak = 0;
    this.recovery = { attempts: 0, nextAt: 0 };
    // Catalog evidence counts only requests newer than the last Codex restart this launcher
    // performed; with no restart, any request since the proxy started is evidence.
    this.catalogBaseline = { requests: 0, atMs: 0 };
    this.routeWarningLogged = false;
  }

  update(patch) {
    const state = this.store.update(patch);
    this.publishState?.(state);
    return state;
  }

  status() {
    let runtime;
    try { runtime = this.supervisor.readState(); } catch { runtime = null; }
    const state = this.store.read();
    return {
      protocol: 'codex-routing-v1',
      enabled: state.routingDisabled !== true,
      busy: this.inFlight !== null,
      // Saved ownership state is not readiness: a proxy the keeper saw failing is not ready.
      runtimeReady: runtime?.status === 'ready' && this.observation?.proxyHealthy !== false,
      runtimeStatus: runtime?.status || 'stopped',
      runtimeDetail: typeof runtime?.detail === 'string' ? redactText(runtime.detail).slice(0, 400) : null,
      routeActive: this.routeActive(),
      proxyHealthy: this.observation?.proxyHealthy ?? null,
      observedAt: this.observation?.at ?? null,
      catalogVerified: state.codexCatalogVerified === true,
      codexRestartRequired: state.codexRestartRequired === true,
      last: this.last,
    };
  }

  paths() {
    const folder = path.join(this.host.coreHome, 'codex');
    return { folder, journal: path.join(folder, 'integration-journal.json'),
      config: path.join(this.host.codexHome, 'config.toml'), history: path.join(folder, 'routing-history') };
  }

  readJournal() {
    const { journal } = this.paths();
    if (!fs.existsSync(journal)) return null;
    return JSON.parse(fs.readFileSync(journal, 'utf8'));
  }

  // Cheap read-only check: does the live Codex config still carry the installed managed route?
  // true/false are evidence; null means the answer could not be read and must not be acted on.
  routeActive() {
    try {
      const { config } = this.paths();
      const journal = this.readJournal();
      if (!journal) return false;
      if (!(journal.active === true || journal.version === 3) || journal.configPath !== config) return false;
      const installed = journal.installed?.openai_base_url;
      if (typeof installed !== 'string' || !fs.existsSync(config)) return null;
      for (const line of fs.readFileSync(config, 'utf8').split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) break;
        const match = /^\s*openai_base_url\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
        if (match) return JSON.parse(`"${match[1]}"`) === installed;
      }
      return false;
    } catch { return null; }
  }

  async observe() {
    let runtime = null;
    try { runtime = this.supervisor.readState(); } catch { runtime = null; }
    let config = null;
    try { config = this.supervisor.readConfig(); } catch { config = null; }
    const health = config ? await this.supervisor.proxyHealthPayload(config) : null;
    const proxyHealthy = Boolean(health && health.service === 'codex-chatgpt-web' && health.status === 'ok'
      && (!Number.isInteger(runtime?.daemonPid) || health.pid === runtime.daemonPid));
    const lastCatalogAt = typeof health?.last_successful_model_catalog_request_at === 'string'
      ? Date.parse(health.last_successful_model_catalog_request_at) : NaN;
    const runtimeUpdatedAt = typeof runtime?.updatedAt === 'string' ? Date.parse(runtime.updatedAt) : NaN;
    this.observation = {
      at: new Date(this.now()).toISOString(),
      runtimeStatus: runtime?.status || 'stopped',
      runtimeUpdatedAtMs: Number.isFinite(runtimeUpdatedAt) ? runtimeUpdatedAt : null,
      proxyHealthy,
      routeActive: this.routeActive(),
      catalogRequests: Number.isInteger(health?.successful_model_catalog_requests) ? health.successful_model_catalog_requests : null,
      lastCatalogAtMs: Number.isFinite(lastCatalogAt) ? lastCatalogAt : null,
    };
    return this.observation;
  }

  captureCatalogBaseline(observed) {
    this.catalogBaseline = { requests: observed?.catalogRequests ?? 0, atMs: this.now() };
    this.update({ codexCatalogVerified: false, codexRestartRequired: false });
    return { ...this.catalogBaseline };
  }

  // A catalog request newer than the baseline proves the running Codex reads models through
  // the proxy, which is the only end-to-end evidence that the Web models are visible.
  verifyCatalog(observed) {
    if (!observed?.proxyHealthy || observed.routeActive !== true) {
      if (this.store.read().codexCatalogVerified === true) this.update({ codexCatalogVerified: false });
      return false;
    }
    if (!observed || observed.catalogRequests === null) return false;
    const { requests, atMs } = this.catalogBaseline;
    const evidence = observed.catalogRequests > requests
      || (observed.lastCatalogAtMs !== null && observed.lastCatalogAtMs > atMs);
    if (!evidence) return false;
    const state = this.store.read();
    if (state.codexCatalogVerified !== true || state.codexRestartRequired === true) {
      this.update({ codexCatalogVerified: true, codexRestartRequired: false });
      this.logger?.info?.('codex.model_catalog_verified', { requests: observed.catalogRequests });
    }
    return true;
  }

  startKeeper() {
    if (this.keeperTimer) return;
    this.keeperTimer = setInterval(() => { void this.keep('interval'); }, this.keeperIntervalMs);
    this.keeperTimer.unref?.();
  }

  stopKeeper() {
    if (this.keeperTimer) clearInterval(this.keeperTimer);
    this.keeperTimer = null;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.recovery = { attempts: 0, nextAt: 0 };
    this.unhealthyStreak = 0;
  }

  // Sleep/wake: probe the owned children now and re-observe once the network has settled.
  // One replaceable timer bounds repeated resume/unlock events. Only a real resume refreshes
  // the ChatGPT session; a screen unlock must not touch the embedded browser surface.
  onSystemResume({ event = 'resume' } = {}) {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    try { this.supervisor.probeNow?.(); } catch (error) { this.logger?.warn?.('routing.resume_probe_failed', { message: message(error) }); }
    const reason = event === 'resume' ? 'system_resume' : 'screen_unlock';
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      void this.keep(reason);
    }, this.resumeSettleMs);
    this.resumeTimer.unref?.();
  }

  keeperWanted() {
    return this.store.read().routingDisabled !== true || this.routeActive() === true;
  }

  keep(reason = 'interval') {
    if (this.keeping) return this.keeping;
    if (this.inFlight || this.host.currentOperation()) return Promise.resolve(null);
    if (!this.keeperWanted()) { this.stopKeeper(); return Promise.resolve(null); }
    this.keeping = this.performKeep(reason).catch(error => {
      this.logger?.warn?.('routing.keeper_recovery_failed', { reason, message: message(error) });
      this.publishOperation?.({ name: 'routing-keeper', status: 'failed', message: `本地运行时恢复失败：${message(error)}` });
      return null;
    }).finally(() => { this.keeping = null; });
    return this.keeping;
  }

  async performKeep(reason) {
    if (reason === 'system_resume' && this.refreshSession) {
      // Browser turns need a live ChatGPT session after wake. The host refuses while a turn or
      // another browser operation is active, which is reported, not retried.
      try { await this.refreshSession(); }
      catch (error) { this.logger?.warn?.('routing.resume_session_refresh_failed', { message: message(error) }); }
    }
    const observed = await this.observe();
    this.verifyCatalog(observed);
    if (observed.routeActive === false && this.store.read().routingDisabled !== true) {
      if (!this.routeWarningLogged) {
        this.routeWarningLogged = true;
        this.logger?.warn?.('routing.route_not_effective', { reason });
      }
    } else if (observed.routeActive === true) this.routeWarningLogged = false;
    if (observed.runtimeStatus === 'ready' && observed.proxyHealthy) {
      this.recovery = { attempts: 0, nextAt: 0 };
      this.unhealthyStreak = 0;
      return observed;
    }
    if (RUNTIME_UNRECOVERABLE_STATUSES.has(observed.runtimeStatus)) return observed;
    // The supervisor owns in-progress transitions and its own crash recovery timers, unless
    // the transition has visibly stalled.
    if (RUNTIME_TRANSITION_STATUSES.has(observed.runtimeStatus)) {
      const stale = observed.runtimeUpdatedAtMs !== null && this.now() - observed.runtimeUpdatedAtMs > KEEPER_TRANSITION_STALE_MS;
      if (!stale) return observed;
    }
    if (observed.runtimeStatus === 'ready') {
      this.unhealthyStreak += 1;
      if (this.unhealthyStreak < KEEPER_UNHEALTHY_STREAK) return observed;
    }
    if (this.now() < this.recovery.nextAt) return observed;
    this.recovery.attempts += 1;
    const attempt = this.recovery.attempts;
    this.recovery.nextAt = this.now() + KEEPER_RECOVERY_BACKOFF_MS[Math.min(attempt - 1, KEEPER_RECOVERY_BACKOFF_MS.length - 1)];
    this.logger?.warn?.('routing.runtime_recovery_started', { reason, attempt, runtimeStatus: observed.runtimeStatus, proxyHealthy: observed.proxyHealthy });
    this.publishOperation?.({ name: 'routing-keeper', status: 'running', message: `本地运行时未就绪，正在恢复（第 ${attempt} 次）…` });
    const runtime = await this.supervisor.startIfConfigured();
    if (runtime.status !== 'ready') throw new Error(runtime.detail || `Runtime is ${runtime.status}`);
    const after = await this.observe();
    if (!after.proxyHealthy) throw new Error('Responses proxy did not answer after recovery');
    this.recovery = { attempts: 0, nextAt: 0 };
    this.unhealthyStreak = 0;
    this.logger?.info?.('routing.runtime_recovered', { reason, attempt });
    this.publishOperation?.({ name: 'routing-keeper', status: 'completed', message: '本地运行时已恢复，路由继续生效' });
    return after;
  }

  async startup() {
    if (this.store.read().routingDisabled === true) {
      // Off is the saved intent. A previous off that did not finish (crash, refused quit or
      // drain) must not leave Codex pointing at a proxy this launcher will not start.
      if (this.routeActive() === true) {
        this.logger?.warn?.('routing.off_intent_with_active_route', {});
        return this.setEnabled(false, { startup: true });
      }
      return this.status();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.setEnabled(true, { startup: true });
      } catch (error) {
        const delay = STARTUP_RETRY_DELAYS_MS[attempt];
        if (error?.untouched !== true || delay === undefined) throw error;
        this.logger?.warn?.('routing.startup_retry_scheduled', { attempt: attempt + 1, delayMs: delay, message: message(error) });
        await this.pause(delay);
        // The user may have taken over in the meantime; their intent and operations win.
        if (this.store.read().routingDisabled === true || this.inFlight) throw error;
      }
    }
  }

  run(operation) {
    // Reject contention rather than retaining unbounded promises or UI callbacks.
    if (this.inFlight) return Promise.reject(new Error('A routing operation is already running'));
    if (this.host.currentOperation()) return Promise.reject(new Error('Wait for the current launcher operation'));
    const task = Promise.resolve(this.keeping).catch(() => null).then(operation)
      .catch(error => {
        this.last = { ok: false, status: 'failed', message: message(error) };
        this.publishOperation?.({ name: 'routing', status: 'failed', message: message(error) });
        throw error;
      });
    this.inFlight = task;
    return task.finally(() => { this.inFlight = null; });
  }

  setEnabled(enabled, options = {}) {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Routing enabled must be boolean'));
    return this.run(() => enabled ? this.enable(options) : this.disable(options));
  }

  sync() {
    return this.run(() => this.performSync());
  }

  restoreCheckpoint() {
    const { journal, config, history } = this.paths();
    if (fs.existsSync(journal) || !fs.existsSync(config) || !fs.existsSync(history)) return;
    for (const name of fs.readdirSync(history).sort().reverse()) {
      const folder = path.join(history, name);
      const metadata = path.join(folder, 'baseline.json');
      const source = path.join(folder, 'integration-journal.json');
      if (!fs.existsSync(metadata) || !fs.existsSync(source)) continue;
      const baseline = JSON.parse(fs.readFileSync(metadata, 'utf8'));
      const saved = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (baseline.configPath === config && baseline.sha256 === digest(config)
        && saved.configPath === config && saved.active === false) {
        writePrivateFileAtomic(journal, JSON.stringify(saved));
      }
      return;
    }
  }

  archiveCheckpoint() {
    const { journal, config, history, folder } = this.paths();
    if (!fs.existsSync(journal)) return;
    const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (saved.active !== false || saved.configPath !== config) throw new Error('Inactive restore journal could not be verified');
    const archive = path.join(history, `${Date.now()}-${process.hrtime.bigint()}`);
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(path.join(archive, 'baseline.json'), JSON.stringify({ configPath: config, sha256: digest(config) }));
    // Keep recovery data until the official restore/readback succeeds.
    for (const name of ['integration-journal.json', 'integration-journal.recovery.json']) {
      const source = path.join(folder, name);
      if (fs.existsSync(source)) fs.renameSync(source, path.join(archive, name));
    }
  }

  async install(prepare) {
    let result;
    await this.setEnabled(true, { prepare: async () => { result = await prepare(); } });
    return result;
  }

  async restartClient(stage) {
    this.publishOperation?.({ name: 'routing', status: 'running', message: `${stage}，正在后台重新打开 Codex…` });
    const baseline = this.captureCatalogBaseline(await this.observe());
    await this.client.reopen();
    try { this.onClientRestarted?.(baseline); } catch (error) { this.logger?.warn?.('routing.client_restart_hook_failed', { message: message(error) }); }
  }

  async enable({ startup = false, prepare } = {}) {
    const previous = this.store.read();
    const previouslyDisabled = previous.routingDisabled === true;
    const routeAlreadyActive = this.routeActive() === true;
    // Rolling back to off is right only when routing was not already in effect; otherwise a
    // failed refresh must not switch a working route off.
    const rollback = previouslyDisabled || !routeAlreadyActive;
    let clientStopped = false;
    let clientSkipped = null;
    // Nothing but the saved intent changes until the client stage has passed; a failure before
    // that point only puts the intent back.
    let untouched = true;
    this.update({ routingDisabled: false });
    this.publishOperation?.({ name: 'routing', status: 'running', message: 'Starting and verifying Web GPT routing' });
    try {
      await this.ready();
      const configured = this.host.runtimeConfigSnapshot();
      if (!configured.configured && !prepare) {
        if (!startup) throw new Error('Complete sign-in and model setup in Settings first');
        this.last = { ok: false, status: 'not-configured' };
        return this.status();
      }
      await this.preflight();
      // An explicit start always restarts Codex so it re-reads the route and catalog. Startup
      // restarts it only when the route must actually change; a route that is already in
      // effect keeps the user's running Codex session untouched.
      const restartClient = Boolean(this.client) && (!startup || !routeAlreadyActive || Boolean(prepare));
      if (restartClient) {
        this.publishOperation?.({ name: 'routing', status: 'running', message: '正在正常退出 ChatGPT.app（Codex 客户端）…' });
        try {
          await this.client.stop();
          clientStopped = true;
        } catch (error) {
          if (!startup) throw error;
          clientSkipped = message(error);
          this.logger?.warn?.('routing.startup_client_restart_skipped', { message: clientSkipped });
        }
      }
      untouched = false;
      if (prepare) await prepare();
      this.restoreCheckpoint();
      const upgrade = await this.host.upgradeManagedRuntime();
      const route = await this.host.bridgeStatus();
      if (!route.installed) await this.host.setupCore();
      const runtime = await this.supervisor.startIfConfigured();
      if (runtime.status !== 'ready') throw new Error(runtime.detail || `Runtime is ${runtime.status}`);
      const connected = await this.host.connectBridgeRoute();
      const report = await this.host.doctor();
      let degradedDoctor = false;
      if (!report.ok) {
        // The browser session is an external readiness signal. Once the local Responses proxy,
        // Tunnel and route are already healthy, a transient Cloudflare/session inspection error
        // must not tear down the service that Codex now depends on. The keeper keeps supervising
        // the local runtime while the next explicit inspection can re-prove the browser session.
        degradedDoctor = browserOnlyDoctorFailure(report)
          && runtime.status === 'ready'
          && connected?.active !== false
          && this.routeActive() === true;
        if (degradedDoctor) {
          this.logger?.warn?.('routing.doctor_degraded', {
            checks: report.checks.filter(check => check?.status === 'error').map(check => ({
              id: check.id,
              message: message(check.message || 'browser verification failed'),
            })),
          });
        } else {
          throw new Error(report.checks.filter(c => c.status === 'error').map(c => c.message).join('; ') || 'Runtime verification failed');
        }
      }
      const config = this.host.runtimeConfigSnapshot().config;
      const routeChanged = connected.changed === true || upgrade?.updated === true;
      this.update({ coreSetupComplete: true, mcpRuntimeInstalled: config?.mode === 'full',
        experimentalBiggerContext: config?.experimentalBiggerContext === true,
        zeroRiskProEnabled: config?.zeroRiskProEnabled === true,
        ...(routeChanged && !clientStopped ? { codexRestartRequired: true, codexCatalogVerified: false } : {}),
        ...(config?.mode === 'browser-only' ? { mcpSetupComplete: false, mcpGuideStep: 0 } : {}),
        ...(config?.mode === 'full' && upgrade?.updated ? { mcpSetupComplete: false, mcpGuideStep: 2 } : {}) });
      if (clientStopped) await this.restartClient('路由验证通过');
      const observed = await this.observe();
      this.verifyCatalog(observed);
      this.startKeeper();
      this.last = { ok: true, status: degradedDoctor ? 'degraded' : 'ready', clientRestarted: clientStopped,
        ...(degradedDoctor ? { message: 'Routing is active; browser session verification is temporarily unavailable. The local runtime will remain supervised.' } : {}),
        ...(clientSkipped ? { message: `路由已生效；Codex 未重启（${clientSkipped}），请稍后手动重启或点击同步模型` } : {}),
        checks: report.checks.map(({ id, status, message: text }) => ({ id, status, message: text })) };
      this.publishOperation?.({ name: 'routing', status: 'completed', message: 'Web GPT routing is ready' });
      return this.status();
    } catch (error) {
      const failures = [];
      if (untouched) {
        this.update({ routingDisabled: previouslyDisabled });
        if (this.keeperWanted()) this.startKeeper();
      } else if (rollback) {
        try { await this.disable({ client: false }); } catch (cause) { failures.push(`restore failed: ${message(cause)}`); }
      } else {
        this.startKeeper();
      }
      // A quit Codex is always reopened; a closed client is worse than any restored state.
      if (clientStopped) {
        try {
          await this.client.reopen({ recovery: true });
          this.update({ codexRestartRequired: false });
        } catch (cause) { failures.push(`Codex reopen failed: ${message(cause)}`); }
      }
      const text = [message(error), ...failures].join('; ');
      this.last = { ok: false, status: 'failed', message: text };
      this.publishOperation?.({ name: 'routing', status: 'failed', message: text });
      const failure = new Error(text);
      failure.untouched = untouched;
      throw failure;
    }
  }

  // Off quits the exact Codex client first (so its in-flight turns do not block the drain and
  // it cannot write config.toml concurrently), stops the owned runtime, restores the
  // pre-activation configuration and reopens Codex only if it was running. `client: false`
  // is used by the enable rollback, which owns the client itself.
  async disable({ client = true } = {}) {
    const previous = this.store.read();
    // Codex only needs the restart when its config still carries the managed route; quitting
    // the launcher while routing is already off must not touch the user's Codex session.
    const restartClient = client && Boolean(this.client) && this.routeActive() !== false;
    let clientStopped = false;
    let runtimeStopped = false;
    this.update({ routingDisabled: true });
    this.stopKeeper();
    this.publishOperation?.({ name: 'routing', status: 'running', message: 'Restoring the configuration from before Web GPT was enabled' });
    try {
      if (restartClient) {
        this.publishOperation?.({ name: 'routing', status: 'running', message: '正在正常退出 ChatGPT.app（Codex 客户端），以便恢复原连接…' });
        await this.client.stop();
        clientStopped = true;
      }
      // Existing supervisor owns drain, tunnel, daemon, restart timers and process trees.
      await this.supervisor.stopForSetup();
      runtimeStopped = true;
      const route = await this.host.restoreBridgeRoute();
      if (route.active) throw new Error('Web GPT route remains active after restore');
      this.archiveCheckpoint();
      let reopened = false;
      if (restartClient) {
        this.publishOperation?.({ name: 'routing', status: 'running', message: '已恢复原连接，正在后台重新打开 Codex…' });
        reopened = (await this.client.reopen({ recovery: true }))?.reopened === true;
      }
      this.update({ codexRestartRequired: restartClient ? false : (route.changed === true || previous.codexRestartRequired === true) });
      this.last = { ok: true, status: 'off', clientRestarted: reopened };
      this.publishOperation?.({ name: 'routing', status: 'completed',
        message: reopened ? 'Previous Codex configuration restored; Codex reopened on the original connection'
          : 'Previous Codex configuration restored; Codex will use the original connection when it starts' });
      return this.status();
    } catch (error) {
      const failures = [];
      // Never leave Codex pointing at a stopped proxy: while the managed route is still in the
      // config, the runtime stays up and the keeper keeps it up until off can finish.
      if (runtimeStopped && this.routeActive() !== false) {
        try {
          const runtime = await this.supervisor.startIfConfigured();
          if (runtime.status !== 'ready') failures.push(`runtime restart: ${runtime.detail || runtime.status}`);
        } catch (cause) { failures.push(`runtime restart failed: ${message(cause)}`); }
      }
      if (clientStopped) {
        try { await this.client.reopen({ recovery: true }); }
        catch (cause) { failures.push(`Codex reopen failed: ${message(cause)}`); }
      }
      if (this.routeActive() !== false) this.startKeeper();
      throw new Error(failures.length ? `${message(error)}; ${failures.join('; ')}` : message(error));
    }
  }

  // "Sync now": make the running Codex adopt the effective catalog and prove it. Verification
  // is a catalog request observed at the proxy after the controlled restart, not a refreshed
  // status card.
  async performSync() {
    if (this.store.read().routingDisabled === true) throw new Error('路由已停用；请先启动路由，再同步模型');
    this.publishOperation?.({ name: 'routing-sync', status: 'running', message: '正在核对本地代理与 Codex 路由…' });
    let observed = await this.observe();
    if (observed.routeActive !== true) throw new Error('Codex 配置未指向本地代理；请点击“启动路由并重启 Codex”重新建立路由');
    if (observed.runtimeStatus !== 'ready' || !observed.proxyHealthy) {
      this.publishOperation?.({ name: 'routing-sync', status: 'running', message: '本地运行时未就绪，正在恢复…' });
      const runtime = await this.supervisor.startIfConfigured();
      if (runtime.status !== 'ready') throw new Error(runtime.detail || `Runtime is ${runtime.status}`);
      observed = await this.observe();
      if (!observed.proxyHealthy) throw new Error('本地代理未响应健康检查');
    }
    this.startKeeper();
    if (!this.client) {
      this.update({ codexRestartRequired: true, codexCatalogVerified: false });
      this.last = { ok: true, status: 'restart-required', message: '路由与代理正常；请手动重启 Codex 以重新读取模型目录' };
      this.publishOperation?.({ name: 'routing-sync', status: 'completed', message: this.last.message });
      return this.status();
    }
    this.publishOperation?.({ name: 'routing-sync', status: 'running', message: '正在正常退出 ChatGPT.app（Codex 客户端）…' });
    await this.client.stop();
    this.publishOperation?.({ name: 'routing-sync', status: 'running', message: '正在后台重新打开 Codex…' });
    const baseline = this.captureCatalogBaseline(observed);
    await this.client.reopen();
    try { this.onClientRestarted?.(baseline); } catch (error) { this.logger?.warn?.('routing.client_restart_hook_failed', { message: message(error) }); }
    this.publishOperation?.({ name: 'routing-sync', status: 'running', message: '等待 Codex 通过本地代理重新读取模型目录…' });
    const deadline = this.now() + CATALOG_SYNC_TIMEOUT_MS;
    for (;;) {
      const current = await this.observe();
      if (this.verifyCatalog(current)) {
        this.last = { ok: true, status: 'synced', message: `Codex 已重新读取模型目录（累计 ${current.catalogRequests} 次请求）` };
        this.publishOperation?.({ name: 'routing-sync', status: 'completed', message: this.last.message });
        return this.status();
      }
      if (this.now() >= deadline) break;
      await this.pause(CATALOG_SYNC_POLL_MS);
    }
    this.last = { ok: true, status: 'restarted', message: 'Codex 已重启，但尚未观察到模型目录请求；打开 Codex 的模型选择器后会自动完成验证' };
    this.publishOperation?.({ name: 'routing-sync', status: 'completed', message: this.last.message });
    return this.status();
  }
}

module.exports = { RoutingSwitch, KEEPER_INTERVAL_MS, KEEPER_RECOVERY_BACKOFF_MS, KEEPER_TRANSITION_STALE_MS,
  KEEPER_UNHEALTHY_STREAK, RESUME_SETTLE_MS, CATALOG_SYNC_TIMEOUT_MS, STARTUP_RETRY_DELAYS_MS };
