const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccountStore } = require("../electron/accounts.cjs");
const { stageNamedTunnel } = require("../electron/hub-tunnel-stage.cjs");

const tunnelId = `tunnel_${"a".repeat(32)}`;
const runtimeKey = "sk-route-hub-test-only-key-123456";

function fixture({ desktopUser = "web-user", routeActive = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-hub-stage-"));
  const userData = path.join(root, "launcher");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const store = createAccountStore({ userData, singleAccount: true });
  store.bindIdentity("default", { id: "web-user", email: "web@example.test" });
  const claims = { sub: "independent-oauth-subject", "https://api.openai.com/auth": {
    chatgpt_user_id: desktopUser, user_id: desktopUser,
  } };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    tokens: { id_token: `header.${payload}.signature` },
  }));
  let clientActions = 0;
  const ctx = {
    profile: { userData, codexHome },
    accountStore: store,
    startupAuthenticationRefresh: Promise.resolve(),
    browserHost: { assertBoundAccountIdentity: async () => true },
    runtimeHost: { currentOperation: () => null },
    stateStore: { read: () => ({ routingDisabled: true }) },
    routingSwitch: { inFlight: null, routeActive: () => routeActive,
      setEnabled: () => { clientActions += 1; } },
  };
  return { ctx, root, store, clientActions: () => clientActions };
}

test("staging saves only this account's private key and leaves its route and client untouched", async t => {
  const { ctx, root, store, clientActions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await stageNamedTunnel(ctx, { tunnelId, runtimeKey });
  assert.deepEqual(result, { tunnelId, staged: true });
  const binding = store.binding("default", "automatic");
  assert.equal(binding.tunnelId, tunnelId);
  assert.equal(fs.readFileSync(binding.runtimeKeyFile, "utf8"), runtimeKey);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(binding.runtimeKeyFile).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(path.join(ctx.profile.userData, "secrets")),
    ["account-default-automatic.key"]);
  assert.equal(clientActions(), 0);
});

test("staging rejects a desktop account mismatch before writing a Tunnel key", async t => {
  const { ctx, root, store } = fixture({ desktopUser: "other-user" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(stageNamedTunnel(ctx, { tunnelId, runtimeKey }), /different ChatGPT account/);
  assert.equal(store.binding("default", "automatic"), null);
});

test("staging refuses to rotate credentials while this account's route is active", async t => {
  const { ctx, root, store } = fixture({ routeActive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(stageNamedTunnel(ctx, { tunnelId, runtimeKey }), /Stop this account/);
  assert.equal(store.binding("default", "automatic"), null);
});
