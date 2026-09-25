const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");

const root = path.resolve(__dirname, "..");
const launcherManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const executable = "node";
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js", { paths: [root] });
const requested = process.argv[2];
const target = requested || (process.platform === "darwin" ? "--mac"
  : process.platform === "win32" ? "--win"
    : process.platform === "linux" ? "--linux"
      : null);
if (!["--mac", "--win", "--linux"].includes(target)) {
  throw new Error(`Unsupported packaging target: ${requested || process.platform}`);
}
const nativeTarget = process.platform === "darwin" ? "--mac"
  : process.platform === "win32" ? "--win"
    : process.platform === "linux" ? "--linux"
      : null;
if (target !== nativeTarget) {
  throw new Error(
    `Cross-packaging ${target} from ${process.platform}/${process.arch} is disabled because the launcher embeds a native Bun runtime. `
    + "Build each target on its matching operating system.",
  );
}

const env = { ...process.env };
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const macZipOnly = target === "--mac" && env.CODEX_ROUTE_HUB_MAC_ZIP_ONLY === "1";
const builderArgs = [
  electronBuilderCli,
  target,
  ...(macZipOnly ? ["zip"] : []),
  "--publish",
  "never",
];
if (target === "--mac" && !env.CSC_LINK && !env.CSC_NAME) {
  builderArgs.push("--config.mac.identity=-");
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-package-"));
const configuredArtifacts = process.env.CODEX_ROUTE_HUB_ARTIFACTS_DIR?.trim();
if (configuredArtifacts && !path.isAbsolute(configuredArtifacts)) {
  throw new Error("CODEX_ROUTE_HUB_ARTIFACTS_DIR must be absolute");
}
const artifactsDirectory = configuredArtifacts || path.join(root, "artifacts");

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? "unknown"}`);
  }
}

function verifySignedMacArchive() {
  const archives = fs.readdirSync(staging)
    .filter(name => /-mac-(?:arm64|x64)\.zip$/.test(name));
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one macOS ZIP for verification; found ${archives.join(", ") || "none"}`);
  }
  const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-mac-verify-"));
  try {
    runChecked("ditto", ["-x", "-k", path.join(staging, archives[0]), verificationRoot]);
    const appBundle = path.join(verificationRoot, `${launcherManifest.build.productName}.app`);
    runChecked("codesign", ["--verify", "--deep", "--strict", appBundle]);
    validateRuntimeBundle(path.join(appBundle, "Contents", "Resources", "runtime"), {
      version: launcherManifest.version,
      platform: "darwin",
      arch: process.arch,
    });
  } finally {
    fs.rmSync(verificationRoot, { recursive: true, force: true });
  }
}

try {
  const result = spawnSync(executable, [
    ...builderArgs,
    `--config.directories.output=${staging}`,
  ], {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`electron-builder failed with status ${result.status ?? "unknown"}`);
  if (target === "--mac") verifySignedMacArchive();

  fs.mkdirSync(artifactsDirectory, { recursive: true });
  for (const entry of fs.readdirSync(artifactsDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith("codex-route-hub-")
      && /\.(?:AppImage|dmg|exe|zip|blockmap)$/i.test(entry.name)) {
      fs.rmSync(path.join(artifactsDirectory, entry.name), { force: true });
    }
  }
  const artifacts = fs.readdirSync(staging, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:AppImage|dmg|exe|zip|blockmap)$/i.test(entry.name));
  if (!artifacts.some((entry) => /\.(?:AppImage|dmg|exe|zip)$/i.test(entry.name))) {
    throw new Error(`electron-builder produced no distributable artifact in ${staging}`);
  }
  for (const artifact of artifacts) {
    const publicName = artifact.name.replace(/-linux-x86_64(?=\.)/, "-linux-x64");
    fs.copyFileSync(path.join(staging, artifact.name), path.join(artifactsDirectory, publicName));
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
