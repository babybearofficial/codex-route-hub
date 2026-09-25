const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const output = path.join(launcherRoot, "build", "runtime");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;

const result = spawnSync(bun, ["run", "scripts/build-runtime-bundle.ts", output], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const notices = spawnSync(bun, [
  "run",
  "scripts/generate-third-party-notices.ts",
  path.join(output, "THIRD_PARTY_NOTICES.txt"),
  "--include-launcher",
], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});
if (notices.error) throw notices.error;
if (notices.status !== 0) process.exit(notices.status ?? 1);
fs.copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(output, "LICENSE"));
fs.cpSync(path.join(repositoryRoot, "LICENSES"), path.join(output, "LICENSES"), { recursive: true });
// electron-builder excludes an extraResources source from app.asar. Stage a separate copy so
// main.cjs can require the module while bundled Bun can execute the standalone guard.
const guardOutput = path.join(launcherRoot, "build", "guard");
fs.mkdirSync(guardOutput, { recursive: true });
fs.copyFileSync(
  path.join(launcherRoot, "electron", "route-exit-guard.cjs"),
  path.join(guardOutput, "route-exit-guard.cjs"),
);
fs.copyFileSync(
  path.join(launcherRoot, "electron", "codex-backend-refresh.cjs"),
  path.join(guardOutput, "codex-backend-refresh.cjs"),
);
// Stage the CLI profile manager separately. Using electron/ directly as an
// extraResources source makes electron-builder exclude these same modules from
// app.asar, where the Hub main process also needs them.
const profileManagerOutput = path.join(launcherRoot, "build", "profile-manager");
fs.mkdirSync(profileManagerOutput, { recursive: true });
for (const name of [
  "profile-manager.cjs",
  "named-instance.cjs",
  "accounts.cjs",
  "account-identity.cjs",
  "atomic-file.cjs",
]) {
  fs.copyFileSync(path.join(launcherRoot, "electron", name), path.join(profileManagerOutput, name));
}
