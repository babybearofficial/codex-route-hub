#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { assertMatchingAccount, authAccountKey } = require("./account-identity.cjs");
const { assertActiveTunnelBinding, createAccountStore } = require("./accounts.cjs");
const {
  MAX_PORT, MIN_PORT, createInstance, instancePaths, instanceRoot,
  listInstances, readInstance, setInstanceDesktopKind, validateName,
} = require("./named-instance.cjs");

const HUB_APP = "/Applications/Codex Route Hub.app";
const FILE_AUTH_CONFIG = 'cli_auth_credentials_store="file"';

function multicodexExecutable(env = process.env) {
  const configured = env.CODEX_ROUTE_HUB_MULTICODEX_BIN?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("MultiCodex executable override must be absolute");
    return configured;
  }
  const local = path.join(os.homedir(), ".local", "share", "codex-route-hub", "MultiCodex", "bin", "multicodex");
  return fs.existsSync(local) ? local : "multicodex";
}

function usage() {
  return [
    "route-hub-profiles create <name> [--color <color>] [--port <17842-17941>] [--json]",
    "route-hub-profiles attach <name> [--port <17842-17941>] [--json]",
    "route-hub-profiles attach-official <name> [--port <17842-17941>] [--json]",
    "route-hub-profiles use-official <name>",
    "route-hub-profiles launch <name>",
    "route-hub-profiles list | status <name>",
    "route-hub-profiles cli-login <name>",
    "route-hub-profiles cli-logout <name>",
    "route-hub-profiles cli <name> -- [codex arguments]",
  ].join("\n");
}

function run(executable, args, { env = process.env, stdio = "inherit" } = {}) {
  const result = spawnSync(executable, args, { env, stdio, encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(`${path.basename(executable)} exited with status ${result.status ?? "unknown"}${detail ? `: ${detail.slice(-700)}` : ""}`);
  }
  return result;
}

function macPlistValue(appPath, key) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], {
    encoding: "utf8", shell: false,
  });
  if (result.error || result.status !== 0) throw new Error(`Cannot read ${key} from ${appPath}`);
  return result.stdout.trim();
}

function assertDesktopApp(paths) {
  if (!fs.existsSync(paths.codexHome) || !fs.existsSync(paths.clientAppPath)) {
    throw new Error("Selected Codex desktop app or account home is missing");
  }
  if (macPlistValue(paths.clientAppPath, "CFBundleIdentifier") !== paths.clientBundleId) {
    throw new Error("Codex desktop app bundle ID does not match this Route Hub instance");
  }
  if (paths.desktopKind === "official") {
    if (macPlistValue(paths.clientAppPath, "CFBundleExecutable") !== "ChatGPT") {
      throw new Error("Official ChatGPT app executable is unexpected");
    }
    return;
  }
  if (macPlistValue(paths.clientAppPath, "CFBundleExecutable") !== "multicodex-launcher") {
    throw new Error("MultiCodex app needs its self-contained profile launcher; run multicodex sync --force");
  }
  const embeddedLauncher = path.join(paths.clientAppPath, "Contents", "MacOS", "multicodex-launcher");
  if (!fs.readFileSync(embeddedLauncher, "utf8").includes(`profile="${path.basename(paths.codexHome)}"`)) {
    throw new Error("MultiCodex app launcher does not point to this instance's Codex home");
  }
}

function parseCreationOptions(args) {
  let port;
  let color;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
    else if (args[i] === "--color" && args[i + 1]) color = args[++i];
    else if (args[i] === "--json") json = true;
    else throw new Error(`Unknown profile option: ${args[i]}`);
  }
  if (port !== undefined && (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT)) {
    throw new Error(`Proxy port must be ${MIN_PORT}–${MAX_PORT}`);
  }
  return { port, color, json };
}

async function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function selectPort(root, requested) {
  const assigned = new Set(listInstances(root).map(item => item.port));
  const candidates = requested === undefined
    ? Array.from({ length: MAX_PORT - MIN_PORT + 1 }, (_, i) => MIN_PORT + i)
    : [requested];
  for (const port of candidates) {
    if (!assigned.has(port) && await portAvailable(port)) return port;
  }
  throw new Error("No unused Route Hub loopback port is available");
}

function profileContext(name, env = process.env) {
  validateName(name);
  const root = instanceRoot(env);
  const instance = readInstance(root, name);
  return { ...instance, root, ...instancePaths(root, name, {
    env, multicodexRoot: instance.multicodexRoot, desktopKind: instance.desktopKind,
  }) };
}

function readLocalStatus(profile) {
  const configPath = path.join(profile.coreHome, "config.json");
  const accountsPath = path.join(profile.userData, "accounts.json");
  const result = { name: profile.name, port: profile.port,
    desktopApp: profile.clientAppPath, codexHome: profile.codexHome,
    configured: false, webAccountIdentified: false, desktopAccountMatches: false,
    cliAccountMatches: false, tunnelBound: false };
  if (!fs.existsSync(accountsPath)) return result;
  const store = createAccountStore({ userData: profile.userData, launcherProfile: "production",
    singleAccount: true, instanceRoot: profile.root, instanceName: profile.name, claimExisting: false });
  result.webAccountIdentified = Boolean(store.active().accountKey);
  if (store.active().accountKey) {
    try { result.desktopAccountMatches = assertMatchingAccount(profile.codexHome, store.active().accountKey, "Desktop Codex"); } catch {}
    try { result.cliAccountMatches = assertMatchingAccount(profile.cliHome, store.active().accountKey, "CLI"); } catch {}
  }
  if (!fs.existsSync(configPath)) return result;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (config.port !== profile.port) throw new Error(`Instance ${profile.name} runtime port differs from its registry`);
  result.configured = config.mode === "full";
  try { result.tunnelBound = assertActiveTunnelBinding(store, store.active().id, config); } catch {}
  return result;
}

function cliAccountKey(cliHome) {
  return authAccountKey(cliHome);
}

async function assertCliRoute(profile) {
  const configPath = path.join(profile.coreHome, "config.json");
  if (!fs.existsSync(configPath)) throw new Error("Route Hub runtime has not been configured for this account");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (config.host !== "127.0.0.1" || config.port !== profile.port || config.mode !== "full") {
    throw new Error("Account runtime is not a matching loopback Full/Tunnel configuration");
  }
  const store = createAccountStore({ userData: profile.userData, launcherProfile: "production",
    singleAccount: true, instanceRoot: profile.root, instanceName: profile.name, claimExisting: false });
  const account = store.active();
  assertActiveTunnelBinding(store, account.id, config);
  assertMatchingAccount(profile.codexHome, account.accountKey, "Desktop Codex");
  assertMatchingAccount(profile.cliHome, account.accountKey, "CLI");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  let health;
  try {
    const response = await fetch(`http://127.0.0.1:${profile.port}/healthz`, { signal: controller.signal });
    if (response.ok) health = await response.json();
  } catch {} finally { clearTimeout(timer); }
  if (health?.service !== "codex-chatgpt-web" || health?.status !== "ok"
    || health?.mode !== "full" || health?.port !== profile.port
    || health?.account_identity_ready !== true
    || health?.accepting_turns !== true) {
    throw new Error("Account Responses proxy is not ready; start its Route Hub instance first");
  }
  return `http://127.0.0.1:${profile.port}/v1`;
}

function assertCliArgs(args) {
  if (args[0] === "login" || args[0] === "logout") {
    throw new Error("Use cli-login to manage this profile's account login");
  }
  if (args.includes("--oss") || args.includes("--local-provider")) {
    throw new Error("Local provider flags cannot be combined with an account Route Hub profile");
  }
  for (let i = 0; i < args.length; i++) {
    const value = args[i] === "-c" || args[i] === "--config" ? args[i + 1] :
      args[i].startsWith("--config=") ? args[i].slice(9) :
        args[i].startsWith("-c") && args[i].length > 2 ? args[i].slice(2) : null;
    if (value && /^\s*(?:openai_base_url|model_provider|cli_auth_credentials_store)\s*=/.test(value)) {
      throw new Error("The account proxy, provider and credential store are fixed by the Route Hub profile");
    }
  }
}

async function main(args = process.argv.slice(2), env = process.env) {
  const [command, name, ...rest] = args;
  const root = instanceRoot(env);
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "list") {
    for (const item of listInstances(root)) {
      const status = readLocalStatus(profileContext(item.name, env));
      process.stdout.write(`${item.name}\tport=${item.port}\tweb=${status.webAccountIdentified ? "identified" : "unverified"}\tdesktop=${status.desktopAccountMatches ? "matched" : "unverified"}\ttunnel=${status.tunnelBound ? "bound" : "unverified"}\n`);
    }
    return;
  }
  if (!name) throw new Error(usage());
  validateName(name);
  if (command === "create" || command === "attach" || command === "attach-official") {
    if (process.platform !== "darwin") throw new Error("MultiCodex desktop profiles require macOS");
    const { port: requested, color, json } = parseCreationOptions(rest);
    if (command !== "create" && color) throw new Error("--color applies only when creating a MultiCodex app");
    if (listInstances(root).some(item => item.name === name)) throw new Error(`Instance already exists: ${name}`);
    const port = await selectPort(root, requested);
    if (command === "create") run(multicodexExecutable(env), ["create", name, ...(color ? ["--color", color] : [])], {
      env, stdio: json ? "pipe" : "inherit",
    });
    const desktopKind = command === "attach-official" ? "official" : "multicodex";
    const paths = instancePaths(root, name, { env, desktopKind });
    assertDesktopApp(paths);
    createInstance(root, name, port, { env, desktopKind });
    process.stdout.write(json
      ? `${JSON.stringify({ name, port, ...paths })}\n`
      : `Registered ${name} on 127.0.0.1:${port}\n`);
    return;
  }
  const profile = profileContext(name, env);
  if (command === "use-official") {
    if (process.platform !== "darwin") throw new Error("Official desktop mapping requires macOS");
    if (fs.existsSync(path.join(profile.coreHome, "config.json"))) {
      throw new Error("Disconnect and remove this instance's configured route before changing its desktop app");
    }
    const official = instancePaths(root, name, {
      env, multicodexRoot: profile.multicodexRoot, desktopKind: "official",
    });
    assertDesktopApp(official);
    const accountsPath = path.join(profile.userData, "accounts.json");
    if (fs.existsSync(accountsPath)) {
      const store = createAccountStore({ userData: profile.userData, singleAccount: true,
        instanceRoot: root, instanceName: name, claimExisting: false });
      if (store.active().accountKey) {
        assertMatchingAccount(official.codexHome, store.active().accountKey, "Official Codex");
      }
    }
    setInstanceDesktopKind(root, name, "official");
    process.stdout.write(`Assigned official ChatGPT.app to ${name}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(readLocalStatus(profile), null, 2)}\n`);
    return;
  }
  if (command === "launch") {
    if (process.platform !== "darwin") throw new Error("MultiCodex desktop launch requires macOS");
    assertDesktopApp(profile);
    const hubApp = env.CODEX_ROUTE_HUB_APP?.trim() || HUB_APP;
    if (!path.isAbsolute(hubApp) || !fs.existsSync(hubApp)) throw new Error("Installed Codex Route Hub app is missing");
    if (!fs.existsSync(path.join(hubApp, "Contents", "Resources", "profile-manager", "named-instance.cjs"))) {
      throw new Error("Installed Codex Route Hub does not contain named-instance support; install the updated app first");
    }
    run("/usr/bin/open", ["-g",
      ...(profile.desktopKind === "official" ? [] : ["--env", `MULTICODEX_ROOT=${profile.multicodexRoot}`]),
      "-a", profile.clientAppPath], { env });
    run("/usr/bin/open", ["-g", "--env", `CODEX_ROUTE_HUB_INSTANCES_ROOT=${root}`,
      "-a", hubApp, "--args", "--profile-manager-launch", "--hidden"], { env });
    process.stdout.write(`Background launch requested for ${name} and the shared Route Hub\n`);
    return;
  }
  if (command === "cli-login") {
    fs.mkdirSync(profile.cliHome, { recursive: true, mode: 0o700 });
    run(env.CODEX_ROUTE_HUB_CODEX_BIN || "codex", ["-c", FILE_AUTH_CONFIG, "login"], {
      env: { ...env, CODEX_HOME: profile.cliHome },
    });
    const accountsPath = path.join(profile.userData, "accounts.json");
    if (fs.existsSync(accountsPath)) {
      const store = createAccountStore({ userData: profile.userData, singleAccount: true,
        instanceRoot: profile.root, instanceName: profile.name, claimExisting: false });
      if (store.active().accountKey) assertMatchingAccount(profile.cliHome, store.active().accountKey, "CLI");
    }
    process.stdout.write("CLI login completed for this isolated account home.\n");
    return;
  }
  if (command === "cli-logout") {
    run(env.CODEX_ROUTE_HUB_CODEX_BIN || "codex", ["-c", FILE_AUTH_CONFIG, "logout"], {
      env: { ...env, CODEX_HOME: profile.cliHome },
    });
    return;
  }
  if (command === "cli") {
    const cliArgs = rest[0] === "--" ? rest.slice(1) : rest;
    assertCliArgs(cliArgs);
    const url = await assertCliRoute(profile);
    const child = spawn(env.CODEX_ROUTE_HUB_CODEX_BIN || "codex", [
      "-c", FILE_AUTH_CONFIG,
      "-c", 'model_provider="openai"',
      "-c", `openai_base_url=${JSON.stringify(url)}`, ...cliArgs,
    ], { env: { ...env, CODEX_HOME: profile.cliHome }, stdio: "inherit", shell: false });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => signal ? reject(new Error(`Codex exited on ${signal}`)) : resolve(exitCode ?? 1));
    });
    if (code !== 0) process.exitCode = code;
    return;
  }
  throw new Error(usage());
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`route-hub-profiles: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { assertCliArgs, assertCliRoute, cliAccountKey, main, parseCreationOptions, profileContext,
  readLocalStatus, selectPort };
