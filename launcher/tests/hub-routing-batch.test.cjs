const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { namedRoutingControl, routingStatuses, setRoutingBatch } = require("../electron/hub-routing-batch.cjs");

function account(id, events, { fail = false, ready = true } = {}) {
  let enabled = false;
  const routingSwitch = {
    inFlight: null,
    async setEnabled(next) {
      events.push([id, next]);
      if (fail) throw new Error(`${id} failed`);
      enabled = next;
    },
    status() {
      return { enabled, routeActive: enabled, runtimeReady: enabled && ready, busy: false };
    },
  };
  return { id, routingSwitch };
}

test("a selected batch changes only selected account bridges in order", async () => {
  const events = [];
  const contexts = new Map(["one", "two", "three"].map(id => [id, account(id, events)]));
  const started = await setRoutingBatch(contexts, ["one", "three"], true);
  assert.deepEqual(events, [["one", true], ["three", true]]);
  assert.deepEqual(started.results.map(result => [result.profileId, result.ok]),
    [["one", true], ["three", true]]);
  assert.equal(routingStatuses(contexts).find(item => item.profileId === "two").status.enabled, false);

  const stopped = await setRoutingBatch(contexts, ["three", "one"], false);
  assert.deepEqual(events.slice(2), [["three", false], ["one", false]]);
  assert.ok(stopped.results.every(result => result.ok && result.status.routeActive === false));
});

test("a failed account is reported without changing or skipping the next account", async () => {
  const events = [];
  const contexts = new Map([
    ["broken", account("broken", events, { fail: true })],
    ["working", account("working", events)],
  ]);
  const result = await setRoutingBatch(contexts, ["broken", "working"], true);
  assert.deepEqual(events, [["broken", true], ["working", true]]);
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error, /broken failed/);
  assert.equal(result.results[1].ok, true);
  assert.equal(result.results[1].status.routeActive, true);
});

test("invalid selections and active operations fail before any account changes", async () => {
  const events = [];
  const contexts = new Map([["one", account("one", events)], ["two", account("two", events)]]);
  for (const selection of [[], ["one", "one"], ["one", "missing"], ["one", 2]]) {
    await assert.rejects(setRoutingBatch(contexts, selection, true));
  }
  await assert.rejects(setRoutingBatch(contexts, ["one"], "true"));
  contexts.get("two").routingSwitch.inFlight = Promise.resolve();
  await assert.rejects(setRoutingBatch(contexts, ["one", "two"], true), /current account routing/);
  assert.deepEqual(events, []);
});

test("a bridge is not reported successful without route and runtime readback", async () => {
  const contexts = new Map([["one", account("one", [], { ready: false })]]);
  const result = await setRoutingBatch(contexts, ["one"], true);
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error, /could not be verified/);
});

test("a staged named Tunnel is installed only when its account is selected for start", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-hub-batch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = path.join(root, "key");
  fs.writeFileSync(key, "sk-route-hub-test-only-key-123456");
  const tunnelId = `tunnel_${"a".repeat(32)}`;
  let config = null;
  let enabled = false;
  const events = [];
  const context = {
    accountStore: {
      active: () => ({ id: "default" }),
      binding: () => ({ tunnelId, runtimeKeyFile: key }),
    },
    browserHost: { assertBoundAccountIdentity: async () => { events.push("identity"); } },
    runtimeHost: {
      runtimeConfigSnapshot: () => ({ config }),
      setupMcp: async input => {
        events.push("setup");
        assert.equal(input.tunnelId, tunnelId);
        assert.equal(input.trustedRuntimeKeyFile, key);
        config = { mode: "full", automaticTunnel: { tunnelId, runtimeKeyFile: key } };
      },
    },
    routingSwitch: {
      inFlight: null,
      install: async prepare => { events.push("install"); await prepare(); enabled = true; },
      setEnabled: async next => { events.push("set"); enabled = next; },
      status: () => ({ enabled, routeActive: enabled, runtimeReady: enabled, busy: false }),
    },
  };
  const contexts = new Map([["named", context]]);
  const result = await setRoutingBatch(contexts, ["named"], true);
  assert.equal(result.results[0].ok, true);
  assert.deepEqual(events, ["identity", "install", "setup"]);
  await setRoutingBatch(contexts, ["named"], true);
  assert.deepEqual(events.slice(3), ["identity", "set"]);

  config = null;
  enabled = false;
  const control = namedRoutingControl(context);
  await control.setEnabled(true);
  assert.deepEqual(events.slice(5), ["identity", "install", "setup"]);
  assert.equal(control.status().routeActive, true);
  await control.setEnabled(false);
  assert.equal(control.status().routeActive, false);
});
