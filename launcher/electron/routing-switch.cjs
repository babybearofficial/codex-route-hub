const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writePrivateFileAtomic } = require('./atomic-file.cjs');
const { redactText } = require('./logging.cjs');

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

class RoutingSwitch {
  constructor({ host, supervisor, store, publishState, publishOperation, ready = async () => {} }) {
    Object.assign(this, { host, supervisor, store, publishState, publishOperation, ready });
    this.inFlight = null;
    this.last = null;
  }

  update(patch) {
    const state = this.store.update(patch);
    this.publishState?.(state);
    return state;
  }

  status() {
    let runtime;
    try { runtime = this.supervisor.readState(); } catch { runtime = null; }
    return {
      protocol: 'codex-routing-v1',
      enabled: this.store.read().routingDisabled !== true,
      busy: this.inFlight !== null,
      runtimeReady: runtime?.status === 'ready',
      last: this.last,
    };
  }

  startup() {
    if (this.store.read().routingDisabled === true) return Promise.resolve(this.status());
    return this.setEnabled(true, { startup: true });
  }

  setEnabled(enabled, options = {}) {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Routing enabled must be boolean'));
    // Reject contention rather than retaining unbounded promises or UI callbacks.
    if (this.inFlight) return Promise.reject(new Error('A routing operation is already running'));
    if (this.host.currentOperation()) return Promise.reject(new Error('Wait for the current launcher operation'));
    const task = Promise.resolve().then(() => enabled ? this.enable(options) : this.disable())
      .catch(error => {
        this.last = { ok: false, status: 'failed', message: redactText(error.message) };
        this.publishOperation?.({ name: 'routing', status: 'failed', message: error.message });
        throw error;
      });
    this.inFlight = task;
    return task.finally(() => { this.inFlight = null; });
  }

  paths() {
    const folder = path.join(this.host.coreHome, 'codex');
    return { folder, journal: path.join(folder, 'integration-journal.json'),
      config: path.join(this.host.codexHome, 'config.toml'), history: path.join(folder, 'routing-history') };
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

  async enable({ startup = false } = {}) {
    this.update({ routingDisabled: false });
    this.publishOperation?.({ name: 'routing', status: 'running', message: 'Starting and verifying Web GPT routing' });
    try {
      await this.ready();
      const configured = this.host.runtimeConfigSnapshot();
      if (!configured.configured) {
        if (!startup) throw new Error('Complete sign-in and model setup in Settings first');
        this.last = { ok: false, status: 'not-configured' };
        return this.status();
      }
      this.restoreCheckpoint();
      const upgrade = await this.host.upgradeManagedRuntime();
      const route = await this.host.bridgeStatus();
      if (!route.installed) await this.host.setupCore();
      const runtime = await this.supervisor.startIfConfigured();
      if (runtime.status !== 'ready') throw new Error(runtime.detail || `Runtime is ${runtime.status}`);
      const connected = await this.host.connectBridgeRoute();
      const report = await this.host.doctor();
      if (!report.ok) throw new Error(report.checks.filter(c => c.status === 'error').map(c => c.message).join('; ') || 'Runtime verification failed');
      const config = this.host.runtimeConfigSnapshot().config;
      this.update({ coreSetupComplete: true, mcpRuntimeInstalled: config?.mode === 'full',
        experimentalBiggerContext: config?.experimentalBiggerContext === true,
        zeroRiskProEnabled: config?.zeroRiskProEnabled === true,
        ...(connected.changed || upgrade?.updated ? { codexRestartRequired: true, codexCatalogVerified: false } : {}),
        ...(config?.mode === 'browser-only' ? { mcpSetupComplete: false, mcpGuideStep: 0 } : {}),
        ...(config?.mode === 'full' && upgrade?.updated ? { mcpSetupComplete: false, mcpGuideStep: 2 } : {}) });
      this.last = { ok: true, status: 'ready', checks: report.checks.map(({ id, status, message }) => ({ id, status, message })) };
      this.publishOperation?.({ name: 'routing', status: 'completed', message: 'Web GPT routing is ready' });
      return this.status();
    } catch (error) {
      let cleanup;
      try { await this.disable(); } catch (cause) { cleanup = cause.message; }
      const message = error.message + (cleanup ? `; restore failed: ${cleanup}` : '');
      this.last = { ok: false, status: 'failed', message };
      this.publishOperation?.({ name: 'routing', status: 'failed', message });
      throw new Error(message);
    }
  }

  async disable() {
    this.update({ routingDisabled: true });
    this.publishOperation?.({ name: 'routing', status: 'running', message: 'Restoring the configuration from before Web GPT was enabled' });
    // Existing supervisor owns drain, tunnel, daemon, restart timers and process trees.
    await this.supervisor.stopForSetup();
    const route = await this.host.restoreBridgeRoute();
    if (route.active) throw new Error('Web GPT route remains active after restore');
    this.archiveCheckpoint();
    this.update({ codexRestartRequired: route.changed === true || this.store.read().codexRestartRequired });
    this.last = { ok: true, status: 'off' };
    this.publishOperation?.({ name: 'routing', status: 'completed', message: 'Previous Codex configuration restored; Codex App remains open' });
    return this.status();
  }
}

module.exports = { RoutingSwitch };
