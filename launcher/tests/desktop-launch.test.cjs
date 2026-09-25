const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { desktopLaunch, hubLaunchEnvironment } = require("../electron/desktop-launch.cjs");
const { resolveLauncherProfile } = require("../electron/profile.cjs");
const { CodexClientLifecycle } = require("../electron/codex-client-lifecycle.cjs");

const homeDir = path.resolve("/Users/tester");
const contaminated = {
  PATH: "/usr/bin:/bin", KEEP: "retained",
  CODEX_HOME: path.join(homeDir, ".multicodex", "profiles", "other"),
  CODEX_ELECTRON_USER_DATA_PATH: path.join(homeDir, "Library", "Application Support", "MultiCodex", "other"),
  MULTICODEX_ROOT: path.join(homeDir, "foreign-profile-root"),
  CODEX_ROUTE_HUB_INSTANCE: "other",
};

test("official reopen replaces inherited clone identity in both Launch Services and child environment", () => {
  const launch = desktopLaunch({ homeDir, env: contaminated });
  const home = path.join(homeDir, ".codex");
  const data = path.join(homeDir, "Library", "Application Support", "Codex");
  assert.equal(launch.env.CODEX_HOME, home);
  assert.equal(launch.env.CODEX_ELECTRON_USER_DATA_PATH, data);
  assert.equal(launch.env.MULTICODEX_ROOT, undefined);
  assert.equal(launch.env.CODEX_ROUTE_HUB_INSTANCE, undefined);
  assert.equal(launch.env.KEEP, "retained");
  assert.ok(launch.args.includes(`CODEX_HOME=${home}`));
  assert.ok(launch.args.includes(`CODEX_ELECTRON_USER_DATA_PATH=${data}`));
  assert.ok(launch.args.includes(`--user-data-dir=${data}`));
  assert.ok(!launch.args.includes("-n"));
  assert.equal(launch.args[0], "-g");
  assert.equal(contaminated.CODEX_ROUTE_HUB_INSTANCE, "other");
});

test("named clone ignores foreign parent roots and keeps all profile paths consistent", () => {
  const root = path.join(homeDir, "custom-profiles");
  const launch = desktopLaunch({ homeDir, env: contaminated,
    appPath: path.join(homeDir, "Applications", "Codex work.app"),
    bundleId: "local.multicodex.work", multicodexRoot: root });
  assert.equal(launch.env.CODEX_HOME, path.join(root, "work"));
  assert.equal(launch.env.MULTICODEX_ROOT, root);
  assert.equal(launch.env.CODEX_ELECTRON_USER_DATA_PATH,
    path.join(homeDir, "Library", "Application Support", "MultiCodex", "work"));
  assert.ok(launch.args.includes(`MULTICODEX_ROOT=${root}`));
  assert.ok(launch.args.includes("-n"));
});

test("shared Hub starts without a caller's desktop or named-instance identity", () => {
  const env = hubLaunchEnvironment(contaminated);
  assert.deepEqual(env, { PATH: contaminated.PATH, KEEP: "retained" });
});

test("Hub opened directly from a clone resolves its default client to the official home", () => {
  const profile = resolveLauncherProfile({ argv: [], env: { ...contaminated,
    CODEX_ROUTE_HUB_INSTANCE: "" }, homeDir, appData: path.join(homeDir, "app-data") });
  assert.equal(profile.codexHome, path.join(homeDir, ".codex"));
  const fromCli = resolveLauncherProfile({ argv: [], env: { CODEX_HOME: contaminated.CODEX_HOME },
    homeDir, appData: path.join(homeDir, "app-data") });
  assert.equal(fromCli.codexHome, path.join(homeDir, ".codex"));
});

test("explicit isolated harness and explicit Hub home overrides still work", () => {
  const env = { ...contaminated, CODEX_ROUTE_HUB_INSTANCE: "",
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(homeDir, "test-launcher") };
  const resolve = value => resolveLauncherProfile({ argv: [], env: value, homeDir,
    appData: path.join(homeDir, "app-data") }).codexHome;
  assert.equal(resolve(env), env.CODEX_HOME);
  assert.equal(resolve({ ...env, CODEX_ROUTE_HUB_CODEX_HOME: path.join(homeDir, "explicit") }),
    path.join(homeDir, "explicit"));
});

test("repeated stop, normal reopen and recovery reopen preserve the selected desktop profile", async () => {
  const calls = [];
  let running = true;
  const codexHome = path.join(homeDir, ".codex");
  const clientUserData = path.join(homeDir, "Library", "Application Support", "Codex");
  const client = new CodexClientLifecycle({ codexHome, clientUserData,
    run: async (exe, args, options) => {
      if (exe.endsWith("/open")) {
        calls.push({ args, env: options.env }); running = true; return { stdout: "" };
      }
      if (args[3].includes("if(true)")) { running = false; return { stdout: '{"pid":123,"accepted":true}' }; }
      return { stdout: running ? '{"pid":123}' : "null" };
    },
  });
  for (let i = 0; i < 3; i++) {
    await client.stop();
    await client.reopen({ recovery: i > 0 });
  }
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.env.CODEX_HOME, codexHome);
    assert.equal(call.env.CODEX_ELECTRON_USER_DATA_PATH, clientUserData);
    assert.ok(call.args.includes(`--user-data-dir=${clientUserData}`));
  }
});

test("unknown desktop identities and relative paths fail before launching", () => {
  assert.throws(() => desktopLaunch({ bundleId: "other.app" }), /identity/);
  assert.throws(() => desktopLaunch({ codexHome: "relative" }), /absolute/);
  assert.throws(() => desktopLaunch({ clientUserData: "relative" }), /absolute/);
});
