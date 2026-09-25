const os = require("node:os");
const path = require("node:path");

// Launch Services inherits the caller's environment. The selected app, rather
// than the Hub's parent process, must own every desktop profile path.
function desktopLaunch({
  appPath = "/Applications/ChatGPT.app", bundleId = "com.openai.codex",
  codexHome, clientUserData, multicodexRoot, homeDir = os.homedir(),
  env = process.env,
} = {}) {
  const official = bundleId === "com.openai.codex";
  const name = /^local\.multicodex\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(bundleId)?.[1];
  if (!official && !name) throw new Error("Desktop launch requires an official or named MultiCodex identity");
  const profileRoot = multicodexRoot || path.join(homeDir, ".multicodex", "profiles");
  const targetHome = codexHome || (official ? path.join(homeDir, ".codex") : path.join(profileRoot, name));
  const targetData = clientUserData || path.join(homeDir, "Library", "Application Support",
    ...(official ? ["Codex"] : ["MultiCodex", name]));
  for (const value of [appPath, targetHome, targetData, profileRoot]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Desktop profile paths must be absolute");
  }
  const launchEnv = hubLaunchEnvironment(env);
  launchEnv.CODEX_HOME = targetHome;
  launchEnv.CODEX_ELECTRON_USER_DATA_PATH = targetData;
  if (!official) launchEnv.MULTICODEX_ROOT = profileRoot;
  return {
    env: launchEnv,
    args: ["-g", ...(!official ? ["-n"] : []),
      "--env", `CODEX_HOME=${targetHome}`,
      "--env", `CODEX_ELECTRON_USER_DATA_PATH=${targetData}`,
      ...(!official ? ["--env", `MULTICODEX_ROOT=${profileRoot}`] : []),
      "-a", appPath, "--args", `--user-data-dir=${targetData}`],
  };
}

function hubLaunchEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of ["CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "MULTICODEX_ROOT", "CODEX_ROUTE_HUB_INSTANCE"]) {
    delete clean[key];
  }
  return clean;
}

module.exports = { desktopLaunch, hubLaunchEnvironment };
