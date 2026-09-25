const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MIN_PORT = 17842;
const MAX_PORT = 17941;
const DESKTOP_KINDS = new Set(["multicodex", "official"]);

function instanceRoot(env = process.env, homeDir = os.homedir()) {
  const configured = env.CODEX_ROUTE_HUB_INSTANCES_ROOT?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("Route Hub instances root must be absolute");
  }
  return configured || path.join(homeDir, ".codex-route-hub", "instances");
}

function validateName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name === "." || name === "..") {
    throw new Error("Instance name must be 1–64 letters, digits, dots, underscores or hyphens");
  }
  return name;
}

function instanceDirectory(root, name) {
  return path.join(root, validateName(name));
}

function manifestPath(root, name) {
  return path.join(instanceDirectory(root, name), "instance.json");
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`Named instance port must be ${MIN_PORT}–${MAX_PORT}`);
  }
  return port;
}

function readInstance(root, name) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath(root, name), "utf8"));
  if (manifest.version !== 1 || manifest.name !== name) {
    throw new Error(`Invalid Route Hub instance manifest: ${name}`);
  }
  validatePort(manifest.port);
  if (typeof manifest.multicodexRoot !== "string" || !path.isAbsolute(manifest.multicodexRoot)) {
    throw new Error(`Instance ${name} has no absolute MultiCodex profile root`);
  }
  const desktopKind = manifest.desktopKind === undefined ? "multicodex" : manifest.desktopKind;
  if (!DESKTOP_KINDS.has(desktopKind)) throw new Error(`Invalid desktop kind for instance ${name}`);
  return { name, port: manifest.port, multicodexRoot: manifest.multicodexRoot, desktopKind };
}

function listInstances(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && NAME_RE.test(entry.name))
    .filter(entry => fs.existsSync(manifestPath(root, entry.name)))
    .map(entry => readInstance(root, entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function instancePaths(root, name, {
  homeDir = os.homedir(),
  env = process.env,
  multicodexRoot: savedMulticodexRoot,
  desktopKind = "multicodex",
} = {}) {
  if (!DESKTOP_KINDS.has(desktopKind)) throw new Error(`Invalid desktop kind: ${desktopKind}`);
  const directory = instanceDirectory(root, name);
  const multicodexRoot = savedMulticodexRoot || (env.MULTICODEX_ROOT?.trim()
    ? path.resolve(env.MULTICODEX_ROOT.trim())
    : path.join(homeDir, ".multicodex", "profiles"));
  return {
    directory,
    coreHome: path.join(directory, "core"),
    userData: path.join(directory, "launcher"),
    cliHome: path.join(directory, "cli"),
    codexHome: desktopKind === "official" ? path.join(homeDir, ".codex") : path.join(multicodexRoot, name),
    clientAppPath: desktopKind === "official" ? "/Applications/ChatGPT.app"
      : path.join(homeDir, "Applications", `Codex ${name}.app`),
    clientBundleId: desktopKind === "official" ? "com.openai.codex" : `local.multicodex.${name}`,
    clientUserData: path.join(homeDir, "Library", "Application Support",
      ...(desktopKind === "official" ? ["Codex"] : ["MultiCodex", name])),
    desktopKind,
  };
}

function createInstance(root, name, port, {
  env = process.env, homeDir = os.homedir(), desktopKind = "multicodex",
} = {}) {
  validateName(name);
  if (!DESKTOP_KINDS.has(desktopKind)) throw new Error(`Invalid desktop kind: ${desktopKind}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".registry.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another instance registration is in progress");
    throw error;
  }
  try {
    const existing = listInstances(root);
    if (existing.some(item => item.name === name) || fs.existsSync(instanceDirectory(root, name))) {
      throw new Error(`Route Hub instance already exists: ${name}`);
    }
    if (desktopKind === "official" && existing.some(item => item.desktopKind === "official")) {
      throw new Error("The official ChatGPT desktop app is already assigned to another instance");
    }
    const selectedPort = port === undefined
      ? Array.from({ length: MAX_PORT - MIN_PORT + 1 }, (_, i) => MIN_PORT + i)
        .find(candidate => !existing.some(item => item.port === candidate))
      : validatePort(port);
    if (!selectedPort || existing.some(item => item.port === selectedPort)) {
      throw new Error("No unique Route Hub loopback port is available in the instance registry");
    }
    const directory = instanceDirectory(root, name);
    const multicodexRoot = path.dirname(instancePaths(root, name, { env, homeDir }).codexHome);
    fs.mkdirSync(directory, { mode: 0o700 });
    try {
      writePrivateFileAtomic(manifestPath(root, name), `${JSON.stringify({
        version: 1, name, port: selectedPort, multicodexRoot, desktopKind,
      }, null, 2)}\n`);
    } catch (error) {
      fs.rmdirSync(directory);
      throw error;
    }
    return { name, port: selectedPort };
  } finally {
    fs.rmdirSync(lock);
  }
}

function setInstanceDesktopKind(root, name, desktopKind) {
  if (!DESKTOP_KINDS.has(desktopKind)) throw new Error(`Invalid desktop kind: ${desktopKind}`);
  const existing = listInstances(root);
  if (desktopKind === "official" && existing.some(item => item.name !== name && item.desktopKind === "official")) {
    throw new Error("The official ChatGPT desktop app is already assigned to another instance");
  }
  const instance = readInstance(root, name);
  writePrivateFileAtomic(manifestPath(root, name), `${JSON.stringify({
    version: 1, name, port: instance.port,
    multicodexRoot: instance.multicodexRoot, desktopKind,
  }, null, 2)}\n`);
  return readInstance(root, name);
}

function resolveNamedInstance({ env = process.env, homeDir = os.homedir() } = {}) {
  const name = env.CODEX_ROUTE_HUB_INSTANCE?.trim();
  if (!name) return null;
  const root = instanceRoot(env, homeDir);
  const instance = readInstance(root, name);
  return { ...instance, root, ...instancePaths(root, name, {
    homeDir, env, multicodexRoot: instance.multicodexRoot, desktopKind: instance.desktopKind,
  }) };
}

module.exports = {
  MAX_PORT,
  MIN_PORT,
  createInstance,
  instancePaths,
  instanceRoot,
  listInstances,
  readInstance,
  resolveNamedInstance,
  setInstanceDesktopKind,
  validateName,
};
