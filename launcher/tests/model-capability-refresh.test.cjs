const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { BrowserHost, isChatGptCloudflareChallengeResponse } = require("../electron/browser-host.cjs");

const homeUrl = "https://chatgpt.com/?temporary-chat=true";
const sessionUrl = "https://chatgpt.com/api/auth/session";
const accountKey = createHash("sha256").update("clone-user").digest("hex");

function hostFixture({ composer = true, sessionStatus = 200, challenged = false } = {}) {
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    state: { authenticated: false }, turnTabs: new Map(), manualOperation: "session inspection",
    expectedAccountKey: accountKey, enforceAccountBinding: true,
    instanceName: "clone", helper: {}, descriptorPath: "/fixture/clone/browser.json",
    getConnectorName: () => "Codex Native2",
    logger: { info() {}, warn() {}, error() {} },
    view: { webContents: {
      id: 45, isDestroyed: () => false, getURL: () => homeUrl,
      executeJavaScript: async script => vm.runInNewContext(script, {
        location: { href: homeUrl }, URL, AbortController,
        document: { readyState: "complete", querySelectorAll: () => composer ? [{
          isConnected: true, getBoundingClientRect: () => ({ width: 600, height: 50 }),
        }] : [] },
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        fetch: async () => ({
          ok: sessionStatus === 200, status: sessionStatus, url: sessionUrl,
          headers: { get: key => key === "cf-mitigated" ? challenged ? "challenge" : null : "application/json" },
          json: async () => ({ user: { id: "clone-user" }, expires: "2099-01-01T00:00:00Z" }),
        }),
        setTimeout: () => null, clearTimeout() {},
      }),
    } },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    snapshot() { return { ...this.state }; },
  });
  return host;
}

test("model inspection preserves a ready Pro account page and its owned helper", async () => {
  const host = hostFixture();
  // A previous transient session failure must not force a new navigation after fresh identity proof.
  host.state.status = "error";
  host.refreshChatGptHomeDocument = async () => { throw new Error("hard refresh would challenge a working page"); };
  let calls = 0;
  host.runBrowserHelperOperation = async options => {
    calls++;
    assert.equal(host.state.accountKey, accountKey);
    assert.equal(options.instanceName, "clone");
    assert.equal(options.descriptorPath, "/fixture/clone/browser.json");
    assert.deepEqual(options.payload, { detectCapabilities: true });
    return { value: { authenticated: true, temporary: true, url: homeUrl,
      solAvailable: true, extraHighAvailable: true, proAvailable: true } };
  };
  const result = await host.runSessionInspection(true);
  assert.equal(result.proAvailable, true);
  assert.equal(calls, 1);
});

test("model inspection still rejects a different account before reading capabilities", async () => {
  const host = hostFixture();
  host.expectedAccountKey = "0".repeat(64);
  host.runBrowserHelperOperation = async () => { throw new Error("must not inspect another account"); };
  await assert.rejects(host.runSessionInspection(true), /changed accounts|not verified/);
});

test("an unavailable composer recovers only its own page before the capability helper", async () => {
  const host = hostFixture({ composer: false });
  const calls = [];
  host.refreshChatGptHomeDocument = async () => calls.push("recover-clone");
  host.runBrowserHelperOperation = async () => {
    calls.push("inspect-clone");
    return { value: { authenticated: true, temporary: true, url: homeUrl,
      solAvailable: true, extraHighAvailable: true, proAvailable: true } };
  };
  await host.runSessionInspection(true);
  assert.deepEqual(calls, ["recover-clone", "inspect-clone"]);
});

test("a signed-in account without its composer is pending readiness, not signed out", async () => {
  const host = hostFixture({ composer: false });
  const result = await host.probeAuthentication({ requireComposer: true });
  assert.equal(result.authenticated, true);
  assert.equal(result.accountKey, accountKey);
  assert.equal(result.composerReady, false);
  assert.equal(result.status, "loading");
  host.clickCloudflareChallenge = async () => ({ clicked: false });
  await assert.rejects(host.waitForAuthenticated(10), /signed in.*composer is unavailable/);
});

test("session challenges remain explicit failures and never grant model capabilities", async () => {
  const host = hostFixture({ sessionStatus: 403, challenged: true });
  const result = await host.probeAuthentication();
  assert.equal(result.authenticated, false);
  assert.equal(result.status, "error");
  assert.match(result.message, /security verification/);
  host.runBrowserHelperOperation = async () => { throw new Error("must not infer Pro from a challenged session"); };
  await assert.rejects(host.runSessionInspection(true), /security verification/);
});

test("identity verification waits for session recovery and rechecks the same account", async () => {
  const host = hostFixture();
  let probes = 0;
  host.probeAuthentication = async () => {
    probes++;
    if (probes === 1) {
      host.cloudflareChallengeRecoverySequence = 1;
      host.cloudflareChallengeRecovery = Promise.resolve().then(() => { host.cloudflareChallengeRecovery = null; });
      return { authenticated: false, status: "error", message: "security verification" };
    }
    return { authenticated: true, accountKey };
  };
  assert.equal(await host.assertBoundAccountIdentity(), accountKey);
  assert.equal(probes, 2);
});

test("session API challenge recovery is narrowly scoped and preserves the active-turn guard", async () => {
  const challenge = { statusCode: 403, url: sessionUrl, webContentsId: 45,
    responseHeaders: { "Cf-Mitigated": ["challenge"] } };
  assert.equal(isChatGptCloudflareChallengeResponse(challenge), true);
  for (const url of ["https://example.com/api/auth/session", "https://chatgpt.com/api/auth/session-other"])
    assert.equal(isChatGptCloudflareChallengeResponse({ ...challenge, url }), false);
  const host = hostFixture();
  host.cloudflareChallengeRecoveryArmed = true;
  host.reloadHomeAfterCloudflareChallenge = async () => {};
  assert.equal(host.handleChatGptBackendResponse({ ...challenge, webContentsId: 46 }), false);
  assert.equal(host.handleChatGptBackendResponse(challenge), true);
  await host.cloudflareChallengeRecovery;
  host.turnTabs.set("active", { status: "running", traceId: "active-trace" });
  host.reloadHomeAfterCloudflareChallenge = async () => { throw new Error("must not reload an active account"); };
  assert.equal(host.handleChatGptBackendResponse(challenge), true);
  assert.equal(host.cloudflareChallengeRecovery, null);
});

test("repeated hidden inspections renew their account viewport after helper disconnect, including failure", async () => {
  const refreshed = [];
  const host = hostFixture();
  host.manualOperation = null;
  host.ready = async () => {};
  host.view.webContents.setBackgroundThrottling = () => {};
  host.syncViewVisibility = () => {
    assert.equal(host.primaryDeviceEmulationDirty, true);
    refreshed.push(host.instanceName);
    host.primaryDeviceEmulationDirty = false;
  };
  host.activateHomeSurface = () => host.syncViewVisibility();
  await host.withManualOperation("session inspection", async () => {});
  await assert.rejects(host.withManualOperation("session inspection", async () => {
    throw new Error("helper failed after disconnect");
  }), /helper failed/);
  assert.deepEqual(refreshed, ["clone", "clone", "clone", "clone"]);
  assert.equal(host.manualOperation, null);
});
