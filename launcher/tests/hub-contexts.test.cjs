const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccountStore, assertActiveTunnelBinding } = require("../electron/accounts.cjs");
const { HubContexts, partitionForInstance, profileIdForInstance } = require("../electron/hub-contexts.cjs");

test("one Hub keeps account sessions and Tunnel bindings isolated when selection changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-hub-contexts-"));
  try {
    const registry = new HubContexts();
    const contexts = ["alice", "bob"].map((name, index) => {
      const userData = path.join(root, name, "launcher");
      fs.mkdirSync(userData, { recursive: true });
      const accountStore = createAccountStore({ userData, singleAccount: true,
        instanceRoot: root, instanceName: name });
      accountStore.bindIdentity("default", { id: `user-${name}`, email: `${name}@example.test` });
      const key = path.join(root, `${name}.key`);
      fs.writeFileSync(key, `${name}-runtime-secret-key-at-least-20-bytes`, { mode: 0o600 });
      const tunnelId = `tunnel_${String(index + 1).repeat(32)}`;
      accountStore.saveTunnel("default", "automatic", { tunnelId, runtimeKeyFile: key });
      const context = {
        id: name, accountStore, partition: partitionForInstance(name),
        browserHost: { snapshot: () => ({ authenticated: true }) },
      };
      registry.add(context);
      return { ...context, tunnelId };
    });

    assert.notEqual(contexts[0].partition, contexts[1].partition);
    assert.notEqual(profileIdForInstance("alice"), profileIdForInstance("bob"));
    assert.equal(registry.snapshot().profiles.every(profile => profile.online), true);
    assert.equal(registry.binding("alice").tunnelId, contexts[0].tunnelId);
    assert.equal(registry.binding("bob").tunnelId, contexts[1].tunnelId);
    assertActiveTunnelBinding(registry, "alice", { mode: "full", tunnel: {
      tunnelId: contexts[0].tunnelId, runtimeKeyFile: registry.binding("alice").runtimeKeyFile,
    } });

    registry.select("bob");
    assert.equal(registry.snapshot().profiles.every(profile => profile.online), true);
    assert.throws(() => assertActiveTunnelBinding(registry, "alice", { mode: "full", tunnel: {
      tunnelId: contexts[0].tunnelId, runtimeKeyFile: registry.binding("alice").runtimeKeyFile,
    } }), /Selected ChatGPT account changed/);
    assertActiveTunnelBinding(registry, "bob", { mode: "full", tunnel: {
      tunnelId: contexts[1].tunnelId, runtimeKeyFile: registry.binding("bob").runtimeKeyFile,
    } });
    assert.throws(() => registry.get("missing"), /does not exist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
