const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createAccountStore } = require("../electron/accounts.cjs");
const { assertMatchingAccount } = require("../electron/account-identity.cjs");
const { CodexClientLifecycle } = require("../electron/codex-client-lifecycle.cjs");
const { createInstance, instancePaths, resolveNamedInstance, setInstanceDesktopKind } = require("../electron/named-instance.cjs");
const { resolveLauncherProfile } = require("../electron/profile.cjs");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { assertCliArgs, assertCliRoute, parseCreationOptions, readLocalStatus } = require("../electron/profile-manager.cjs");

function temporary(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-hub-parallel-"));
  try { return callback(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function authToken(chatgptUserId, sub = "unrelated-oauth-subject") {
  const payload = Buffer.from(JSON.stringify({
    sub,
    "https://api.openai.com/auth": {
      chatgpt_user_id: chatgptUserId,
      user_id: chatgptUserId,
    },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

test("named instances isolate every writable home, proxy port and desktop identity", () => temporary(root => {
  const instances = path.join(root, "instances");
  const homeDir = path.join(root, "home");
  const env = { CODEX_ROUTE_HUB_INSTANCES_ROOT: instances,
    MULTICODEX_ROOT: path.join(root, "multicodex") };
  createInstance(instances, "work", 17842, { env, homeDir });
  createInstance(instances, "personal", 17843, { env, homeDir });
  assert.throws(() => createInstance(instances, "other", 17843, { env, homeDir }), /unique/);
  const work = resolveNamedInstance({ env: { ...env, CODEX_ROUTE_HUB_INSTANCE: "work" }, homeDir });
  const personal = resolveNamedInstance({ env: { ...env, CODEX_ROUTE_HUB_INSTANCE: "personal" }, homeDir });
  for (const key of ["coreHome", "userData", "codexHome", "clientAppPath", "clientBundleId"]) {
    assert.notEqual(work[key], personal[key], key);
  }
  assert.notEqual(work.port, personal.port);
  assert.equal(work.codexHome, path.join(root, "multicodex", "work"));
  assert.equal(work.clientBundleId, "local.multicodex.work");
  const launcher = resolveLauncherProfile({ env: { ...env, CODEX_ROUTE_HUB_INSTANCE: "work" }, homeDir,
    appData: path.join(homeDir, "Library", "Application Support") });
  assert.equal(launcher.coreHome, work.coreHome);
  assert.equal(launcher.port, 17842);
  assert.equal(launcher.clientBundleId, "local.multicodex.work");
  assert.throws(() => instancePaths(instances, "../escape"), /Instance name/);
}));

test("one named instance can use the official app while another uses a clone", () => temporary(root => {
  const instances = path.join(root, "instances");
  const homeDir = path.join(root, "home");
  const env = { CODEX_ROUTE_HUB_INSTANCES_ROOT: instances };
  createInstance(instances, "primary", 17842, { env, homeDir, desktopKind: "official" });
  createInstance(instances, "secondary", 17843, { env, homeDir });
  const primary = resolveNamedInstance({ env: { ...env, CODEX_ROUTE_HUB_INSTANCE: "primary" }, homeDir });
  const secondary = resolveNamedInstance({ env: { ...env, CODEX_ROUTE_HUB_INSTANCE: "secondary" }, homeDir });
  assert.equal(primary.codexHome, path.join(homeDir, ".codex"));
  assert.equal(primary.clientAppPath, "/Applications/ChatGPT.app");
  assert.equal(primary.clientBundleId, "com.openai.codex");
  assert.equal(primary.desktopKind, "official");
  assert.notEqual(primary.codexHome, secondary.codexHome);
  assert.throws(() => setInstanceDesktopKind(instances, "secondary", "official"), /already assigned/);
  const launcher = resolveLauncherProfile({ env: { ...env, CODEX_ROUTE_HUB_INSTANCE: "primary" },
    homeDir, appData: path.join(homeDir, "Library", "Application Support") });
  assert.equal(launcher.codexHome, primary.codexHome);
  assert.equal(launcher.clientBundleId, primary.clientBundleId);
}));

test("an existing clone can be reassigned to the official desktop app", () => temporary(root => {
  const instances = path.join(root, "instances");
  const homeDir = path.join(root, "home");
  createInstance(instances, "primary", 17842, { homeDir });
  setInstanceDesktopKind(instances, "primary", "official");
  const primary = resolveNamedInstance({ env: { CODEX_ROUTE_HUB_INSTANCES_ROOT: instances,
    CODEX_ROUTE_HUB_INSTANCE: "primary" }, homeDir });
  assert.equal(primary.codexHome, path.join(homeDir, ".codex"));
  assert.equal(primary.desktopKind, "official");
}));

test("profile creation accepts machine-readable output for the Hub controller", () => {
  assert.deepEqual(parseCreationOptions(["--port", "17844", "--color", "blue", "--json"]),
    { port: 17844, color: "blue", json: true });
});

test("profile status reports verified Web and desktop identity before runtime setup", () => temporary(root => {
  const userData = path.join(root, "launcher");
  const codexHome = path.join(root, "desktop");
  const cliHome = path.join(root, "cli");
  fs.mkdirSync(codexHome);
  const store = createAccountStore({ userData, singleAccount: true,
    instanceRoot: root, instanceName: "work" });
  store.bindIdentity("default", { id: "user-work" });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    tokens: { id_token: authToken("user-work") },
  }));
  const status = readLocalStatus({ name: "work", port: 17842, root, userData,
    coreHome: path.join(root, "core"), codexHome, cliHome, clientAppPath: "/Codex work.app" });
  assert.equal(status.webAccountIdentified, true);
  assert.equal(status.desktopAccountMatches, true);
  assert.equal(status.configured, false);
  assert.equal(status.tunnelBound, false);
}));

test("separate instances cannot claim the same Web account or Tunnel", () => temporary(root => {
  const instances = path.join(root, "instances");
  const work = createAccountStore({ userData: path.join(root, "work"), singleAccount: true,
    instanceRoot: instances, instanceName: "work" });
  const personal = createAccountStore({ userData: path.join(root, "personal"), singleAccount: true,
    instanceRoot: instances, instanceName: "personal" });
  assert.throws(() => work.create(), /one account/);
  work.bindIdentity("default", { id: "user-work" });
  assert.throws(() => personal.bindIdentity("default", { id: "user-work" }), /another Route Hub instance/);
  personal.bindIdentity("default", { id: "user-personal" });
  const tunnelId = `tunnel_${"a".repeat(32)}`;
  work.reserveTunnel("default", "automatic", tunnelId);
  assert.throws(() => personal.reserveTunnel("default", "automatic", tunnelId), /another Route Hub instance/);
  const key = path.join(root, "key");
  fs.writeFileSync(key, "private-runtime-key-for-test-only");
  work.saveTunnel("default", "automatic", { tunnelId, runtimeKeyFile: key });
  assert.throws(() => work.saveTunnel("default", "manual", { tunnelId, runtimeKeyFile: key }), /already bound/);
}));

test("desktop and CLI authentication IDs must match the Web account", () => temporary(root => {
  const desktop = path.join(root, "desktop");
  const cli = path.join(root, "cli");
  fs.mkdirSync(desktop);
  fs.mkdirSync(cli);
  fs.writeFileSync(path.join(desktop, "auth.json"), JSON.stringify({ tokens: { id_token: authToken("user-work") } }));
  fs.writeFileSync(path.join(cli, "auth.json"), JSON.stringify({ tokens: { id_token: authToken("user-personal") } }));
  const expected = createHash("sha256").update("user-work").digest("hex");
  assert.equal(assertMatchingAccount(desktop, expected, "Desktop Codex"), true);
  assert.throws(() => assertMatchingAccount(cli, expected, "CLI"), /different ChatGPT account/);
  fs.writeFileSync(path.join(cli, "auth.json"), JSON.stringify({
    tokens: { id_token: `header.${Buffer.from(JSON.stringify({ sub: "user-work" })).toString("base64url")}.signature` },
  }));
  assert.throws(() => assertMatchingAccount(cli, expected, "CLI"), /no ChatGPT user identity claim/);
  fs.writeFileSync(path.join(cli, "auth.json"), JSON.stringify({
    tokens: { id_token: `header.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_user_id: 123, user_id: "user-work" },
    })).toString("base64url")}.signature` },
  }));
  assert.throws(() => assertMatchingAccount(cli, expected, "CLI"), /invalid ChatGPT user identity claim/);
}));

test("client lifecycle targets the exact cloned path and bundle ID", async () => {
  const calls = [];
  let running = false;
  const client = new CodexClientLifecycle({
    appPath: "/Users/tester/Applications/Codex work.app",
    bundleId: "local.multicodex.work",
    multicodexRoot: "/Users/tester/.multicodex/profiles",
    clientUserData: "/Users/tester/Library/Application Support/MultiCodex/work",
    run: async (exe, args) => {
      calls.push([exe, args]);
      if (exe.endsWith("osascript")) return { stdout: running ? '{"pid":42}' : "null" };
      running = true;
      return { stdout: "" };
    },
  });
  assert.equal(await client.running(), false);
  assert.deepEqual(await client.reopen(), { reopened: true });
  const script = calls[0][1][3];
  assert.match(script, /local\.multicodex\.work/);
  assert.match(script, /Codex work\.app/);
  assert.doesNotMatch(script, /===\s*'com\.openai\.codex'/);
  assert.deepEqual(calls.find(([exe]) => exe.endsWith("open"))[1], [
    "-g", "-n", "--env", `CODEX_HOME=${path.join("/Users/tester/.multicodex/profiles", "work")}`,
    "--env", "CODEX_ELECTRON_USER_DATA_PATH=/Users/tester/Library/Application Support/MultiCodex/work",
    "--env", "MULTICODEX_ROOT=/Users/tester/.multicodex/profiles",
    "-a", "/Users/tester/Applications/Codex work.app", "--args",
    "--user-data-dir=/Users/tester/Library/Application Support/MultiCodex/work",
  ]);
});

test("named runtime refuses a mismatched configured port before starting", () => {
  const host = new RuntimeHost({
    app: { getPath: () => "/tmp", getVersion: () => "5.0.8" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source", browserDescriptorPath: "/runtime/browser.json",
    coreHome: "/runtime", codexHome: "/codex", proxyPort: 17842, instanceName: "work",
    supervisor: { readSetupConfig: () => ({ browserHost: "launcher", port: 17843 }),
      readConfig: () => ({ browserHost: "launcher", port: 17843 }) },
  });
  assert.throws(() => host.runtimeConfigSnapshot(), /owns port 17842/);
});

test("every named setup phase uses the assigned port", async () => {
  const invocations = [];
  const host = new RuntimeHost({
    app: { getPath: () => "/tmp", getVersion: () => "5.0.8" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source", browserDescriptorPath: "/runtime/browser.json",
    coreHome: "/runtime", codexHome: "/codex", proxyPort: 17842, instanceName: "work",
    supervisor: {
      readSetupConfig: () => null,
      readConfig: () => null,
      stopForSetup: async () => {},
      startIfConfigured: async () => ({ status: "ready" }),
    },
  });
  host.captureSetupCheckpoint = () => [];
  host.run = async (_name, args) => { invocations.push(args); return { stdout: "" }; };
  await host.runSetup("named-setup", ["setup", "--full"], {});
  assert.deepEqual(invocations, [
    ["setup", "--full", "--port", "17842", "--preflight-only"],
    ["setup", "--full", "--port", "17842"],
  ]);
});

test("CLI can use only its matching account's healthy Full/Tunnel proxy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-hub-cli-route-"));
  const previousFetch = global.fetch;
  try {
    const userData = path.join(root, "launcher");
    const coreHome = path.join(root, "core");
    const codexHome = path.join(root, "desktop");
    const cliHome = path.join(root, "cli");
    for (const directory of [userData, coreHome, codexHome, cliHome]) fs.mkdirSync(directory);
    const store = createAccountStore({ userData, singleAccount: true,
      instanceRoot: root, instanceName: "work" });
    store.bindIdentity("default", { id: "user-work" });
    const keyFile = path.join(root, "key");
    fs.writeFileSync(keyFile, "fixture-runtime-key-for-work-account");
    const tunnelId = `tunnel_${"b".repeat(32)}`;
    store.saveTunnel("default", "automatic", { tunnelId, runtimeKeyFile: keyFile });
    fs.writeFileSync(path.join(coreHome, "config.json"), JSON.stringify({
      host: "127.0.0.1", port: 17842, mode: "full",
      automaticTunnel: { tunnelId, runtimeKeyFile: keyFile },
    }));
    for (const directory of [codexHome, cliHome]) {
      fs.writeFileSync(path.join(directory, "auth.json"), JSON.stringify({
        tokens: { id_token: authToken("user-work") },
      }));
    }
    const profile = { name: "work", root, userData, coreHome, codexHome, cliHome, port: 17842 };
    global.fetch = async () => ({ ok: true, json: async () => ({
      service: "codex-chatgpt-web", status: "ok", mode: "full", port: 17842,
      accepting_turns: true, account_identity_ready: true,
    }) });
    assert.equal(await assertCliRoute(profile), "http://127.0.0.1:17842/v1");
    assert.throws(() => assertCliArgs(["-c", 'openai_base_url="https://other.example/v1"']), /fixed/);
    assert.throws(() => assertCliArgs(['-cmodel_provider="other"']), /fixed/);
    assert.throws(() => assertCliArgs(['--config=cli_auth_credentials_store="keyring"']), /fixed/);
    fs.writeFileSync(path.join(cliHome, "auth.json"), JSON.stringify({
      tokens: { id_token: authToken("user-personal") },
    }));
    await assert.rejects(assertCliRoute(profile), /different ChatGPT account/);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
