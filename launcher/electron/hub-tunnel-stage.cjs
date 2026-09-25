const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { assertMatchingAccount } = require("./account-identity.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

async function stageNamedTunnel(ctx, { tunnelId, runtimeKey } = {}) {
  if (ctx.routingSwitch.inFlight || ctx.runtimeHost.currentOperation()
    || ctx.stateStore.read().routingDisabled !== true || ctx.routingSwitch.routeActive() !== false) {
    throw new Error("Stop this account's bridge before saving new Tunnel credentials");
  }
  const id = typeof tunnelId === "string" ? tunnelId.trim() : "";
  const key = typeof runtimeKey === "string" ? runtimeKey.trim() : "";
  if (!/^tunnel_[a-f0-9]{32}$/.test(id) || !/^\S{20,}$/.test(key)
    || Buffer.byteLength(key) > 64 * 1024) {
    throw new Error("A valid Tunnel ID and private runtime key are required");
  }
  await ctx.startupAuthenticationRefresh;
  await ctx.browserHost.assertBoundAccountIdentity();
  assertMatchingAccount(ctx.profile.codexHome, ctx.accountStore.active().accountKey, "Desktop Codex");

  let releaseReservation = null;
  const temporaryKey = path.join(ctx.profile.userData, "secrets",
    `runtime-key-stage-${randomBytes(16).toString("hex")}.tmp`);
  try {
    releaseReservation = ctx.accountStore.reserveTunnel("default", "automatic", id);
    writePrivateFileAtomic(temporaryKey, key);
    ctx.accountStore.saveTunnel("default", "automatic", { tunnelId: id, runtimeKeyFile: temporaryKey });
    releaseReservation = null;
    const binding = ctx.accountStore.binding("default", "automatic");
    if (binding?.tunnelId !== id) throw new Error("Saved Tunnel binding could not be verified");
    return { tunnelId: id, staged: true };
  } catch (error) {
    releaseReservation?.();
    throw error;
  } finally {
    fs.rmSync(temporaryKey, { force: true });
  }
}

module.exports = { stageNamedTunnel };
