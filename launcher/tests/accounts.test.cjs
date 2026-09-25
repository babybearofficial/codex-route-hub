const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertActiveTunnelBinding, createAccountStore, identityFromSession, partitionForProfile } = require("../electron/accounts.cjs");

test("each ChatGPT account keeps a separate browser partition and Tunnel key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-hub-accounts-"));
  try {
    const store = createAccountStore({ userData: root });
    const other = store.create();
    assert.notEqual(store.partition(other.id), store.partition("default"));
    assert.equal(store.partition("default"), "persist:codex-web-gpt-chatgpt");
    assert.notEqual(partitionForProfile(other.id, "development"), store.partition(other.id));
    const first = store.bindIdentity("default", { id: "user-1", email: "one@example.test" });
    const second = store.bindIdentity(other.id, { id: "user-2", email: "two@example.test" });
    assert.notEqual(first.accountKey, second.accountKey);
    assert.throws(() => store.bindIdentity(other.id, { id: "user-1" }), /another ChatGPT account|already registered/);
    const sourceKey = path.join(root, "source.key");
    const tunnelId = `tunnel_${"a".repeat(32)}`;
    fs.writeFileSync(sourceKey, "this-is-an-account-scoped-runtime-key");
    assert.throws(() => store.saveTunnel("default", "automatic", { tunnelId, runtimeKeyFile: "relative" }), /Invalid/);
    const bound = store.saveTunnel("default", "automatic", { tunnelId, runtimeKeyFile: sourceKey });
    const runtimeKey = path.join(root, "active.key");
    fs.copyFileSync(sourceKey, runtimeKey);
    assert.equal(assertActiveTunnelBinding(store, "default", {
      mode: "full", automaticTunnel: { tunnelId, runtimeKeyFile: runtimeKey },
    }), true);
    assert.throws(() => assertActiveTunnelBinding(store, "default", {
      mode: "full", automaticTunnel: { tunnelId: `tunnel_${"b".repeat(32)}`, runtimeKeyFile: runtimeKey },
    }), /matching active Tunnel/);
    fs.writeFileSync(runtimeKey, "this-is-a-different-account-runtime-key");
    assert.throws(() => assertActiveTunnelBinding(store, "default", {
      mode: "full", automaticTunnel: { tunnelId, runtimeKeyFile: runtimeKey },
    }), /key does not match/);
    assert.equal(fs.readFileSync(bound.runtimeKeyFile, "utf8"), fs.readFileSync(sourceKey, "utf8"));
    assert.equal(fs.statSync(bound.runtimeKeyFile).mode & 0o777, 0o600);
    assert.equal(store.binding(other.id), null);
    assert.equal(store.snapshot().profiles.find(profile => profile.id === other.id).tunnelConfigured, false);
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /runtime-key|source\.key/);
    store.select(other.id);
    assert.equal(createAccountStore({ userData: root }).active().id, other.id);
    assert.equal(identityFromSession({ id: "user-1" }).accountKey, first.accountKey);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
