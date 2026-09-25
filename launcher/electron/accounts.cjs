const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const LEGACY_PROFILE_ID = "default";
const PROFILE_ID_RE = /^(?:default|[a-f0-9]{32})$/;
const ACCOUNT_KEY_RE = /^[a-f0-9]{64}$/;
const TUNNEL_ID_RE = /^tunnel_[a-f0-9]{32}$/;
const MAX_PROFILES = 8;

function identityFromSession(user) {
  if (!user || typeof user.id !== "string" || !user.id.trim()) {
    throw new Error("ChatGPT session has no stable account ID; account routing is blocked");
  }
  const accountKey = createHash("sha256").update(user.id).digest("hex");
  const email = typeof user.email === "string" && user.email.length <= 254
    ? user.email.trim() : "";
  const name = typeof user.name === "string" && user.name.length <= 100
    ? user.name.trim() : "";
  return { accountKey, label: email || name || `Account ${accountKey.slice(0, 8)}` };
}

function partitionForProfile(profileId, launcherProfile = "production") {
  if (!PROFILE_ID_RE.test(profileId)) throw new Error("Invalid local account profile ID");
  if (launcherProfile !== "production" && launcherProfile !== "development") {
    throw new Error("Invalid launcher profile");
  }
  const base = launcherProfile === "development"
    ? "persist:codex-web-gpt-dev-chatgpt"
    : "persist:codex-web-gpt-chatgpt";
  return profileId === LEGACY_PROFILE_ID ? base : `${base}-account-${profileId}`;
}

function initialAccounts() {
  return { version: 1, activeProfileId: LEGACY_PROFILE_ID, profiles: [
    { id: LEGACY_PROFILE_ID, accountKey: null, label: "Primary account", tunnels: {} },
  ] };
}

function readAccounts(filePath) {
  if (!fs.existsSync(filePath)) return initialAccounts();
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (data?.version !== 1 || !Array.isArray(data.profiles)
    || data.profiles.length < 1 || data.profiles.length > MAX_PROFILES
    || !PROFILE_ID_RE.test(data.activeProfileId)) {
    throw new Error("Account registry is invalid; refusing to guess the active account");
  }
  const ids = new Set();
  const keys = new Set();
  const tunnelIds = new Set();
  for (const profile of data.profiles) {
    if (!PROFILE_ID_RE.test(profile?.id) || ids.has(profile.id)
      || (profile.accountKey !== null && !ACCOUNT_KEY_RE.test(profile.accountKey))
      || (profile.accountKey && keys.has(profile.accountKey))
      || typeof profile.label !== "string" || profile.label.length > 254
      || !profile.tunnels || typeof profile.tunnels !== "object") {
      throw new Error("Account registry contains an invalid or duplicated profile");
    }
    ids.add(profile.id);
    if (profile.accountKey) keys.add(profile.accountKey);
    for (const mode of ["automatic", "manual"]) {
      if (profile.tunnels[mode] !== undefined
        && !TUNNEL_ID_RE.test(profile.tunnels[mode]?.tunnelId)) {
        throw new Error("Account registry contains an invalid tunnel binding");
      }
      const tunnelId = profile.tunnels[mode]?.tunnelId;
      if (tunnelId && tunnelIds.has(tunnelId)) {
        throw new Error("Account registry reuses one Tunnel for multiple bindings");
      }
      if (tunnelId) tunnelIds.add(tunnelId);
    }
  }
  if (!ids.has(data.activeProfileId)) throw new Error("Active account profile is missing");
  return data;
}

function createAccountStore({ userData, launcherProfile = "production", singleAccount = false,
  instanceRoot = null, instanceName = null, claimExisting = true }) {
  const filePath = path.join(userData, "accounts.json");
  let data = readAccounts(filePath);
  if (singleAccount && data.profiles.length !== 1) {
    throw new Error("Named Route Hub instances support exactly one ChatGPT account");
  }
  if (instanceRoot !== null && (!path.isAbsolute(instanceRoot) || !instanceName)) {
    throw new Error("Named account claim registry requires an absolute instance root and name");
  }
  const persist = () => writePrivateFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
  const claim = (kind, value) => {
    if (!instanceRoot) return () => {};
    const target = path.join(instanceRoot, ".claims", kind, value);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(target, instanceName, { flag: "wx", mode: 0o600 });
      return () => fs.rmSync(target, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (fs.readFileSync(target, "utf8") !== instanceName) {
        throw new Error(`This ${kind === "accounts" ? "ChatGPT account" : "Tunnel"} belongs to another Route Hub instance`);
      }
      return () => {};
    }
  };
  const releaseOwnedClaim = (kind, value) => {
    if (!instanceRoot || !value) return;
    const target = path.join(instanceRoot, ".claims", kind, value);
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === instanceName) {
      fs.rmSync(target);
    }
  };
  if (claimExisting) {
    for (const profile of data.profiles) {
      if (profile.accountKey) claim("accounts", profile.accountKey);
      for (const tunnel of Object.values(profile.tunnels)) {
        if (tunnel?.tunnelId) claim("tunnels", tunnel.tunnelId);
      }
    }
  }
  const find = id => {
    const profile = data.profiles.find(item => item.id === id);
    if (!profile) throw new Error("Account profile does not exist");
    return profile;
  };
  const keyPath = (id, mode) => {
    if (!PROFILE_ID_RE.test(id) || (mode !== "automatic" && mode !== "manual")) {
      throw new Error("Invalid account tunnel key target");
    }
    return path.join(userData, "secrets", `account-${id}-${mode}.key`);
  };
  return {
    active() { return structuredClone(find(data.activeProfileId)); },
    profile(id) { return structuredClone(find(id)); },
    snapshot() {
      return { activeProfileId: data.activeProfileId, profiles: data.profiles.map(profile => ({
        id: profile.id,
        label: profile.label,
        identified: Boolean(profile.accountKey),
        tunnelConfigured: Boolean(profile.tunnels.automatic
          && fs.existsSync(keyPath(profile.id, "automatic"))),
      })) };
    },
    partition(id) { find(id); return partitionForProfile(id, launcherProfile); },
    create() {
      if (singleAccount) throw new Error("Named Route Hub instances support one account; create another instance instead");
      if (data.profiles.length >= MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} accounts are supported`);
      const profile = {
        id: randomBytes(16).toString("hex"), accountKey: null,
        label: `Account ${data.profiles.length + 1}`, tunnels: {},
      };
      data.profiles.push(profile);
      persist();
      return structuredClone(profile);
    },
    select(id) {
      find(id);
      if (singleAccount && id !== data.activeProfileId) throw new Error("Named Route Hub account cannot be switched");
      data.activeProfileId = id;
      persist();
      return this.snapshot();
    },
    bindIdentity(id, user) {
      const identity = identityFromSession(user);
      const profile = find(id);
      if (profile.accountKey && profile.accountKey !== identity.accountKey) {
        throw new Error("This browser profile is bound to another ChatGPT account; use a separate account profile");
      }
      if (data.profiles.some(other => other.id !== id && other.accountKey === identity.accountKey)) {
        throw new Error("This ChatGPT account is already registered in another browser profile");
      }
      const releaseClaim = claim("accounts", identity.accountKey);
      if (profile.accountKey !== identity.accountKey || profile.label !== identity.label) {
        const previous = { accountKey: profile.accountKey, label: profile.label };
        try {
          profile.accountKey = identity.accountKey;
          profile.label = identity.label;
          persist();
        } catch (error) {
          Object.assign(profile, previous);
          releaseClaim();
          throw error;
        }
      }
      return identity;
    },
    binding(id, mode = "automatic") {
      const profile = find(id);
      if (!profile.accountKey) return null;
      const tunnel = profile.tunnels[mode];
      const runtimeKeyFile = keyPath(id, mode);
      if (!tunnel || !fs.existsSync(runtimeKeyFile)) return null;
      return { tunnelId: tunnel.tunnelId, runtimeKeyFile, accountKey: profile.accountKey };
    },
    reserveTunnel(id, mode, tunnelId) {
      const profile = find(id);
      if (!profile.accountKey) throw new Error("Verify the ChatGPT account before binding a Tunnel");
      if (mode !== "automatic" && mode !== "manual") throw new Error("Invalid Tunnel interaction mode");
      if (!TUNNEL_ID_RE.test(tunnelId)) throw new Error("Invalid Tunnel ID");
      if (data.profiles.some(other => Object.entries(other.tunnels).some(([otherMode, bound]) =>
        (other.id !== id || otherMode !== mode) && bound?.tunnelId === tunnelId))) {
        throw new Error("This Tunnel is already bound to another account or interaction mode");
      }
      return claim("tunnels", tunnelId);
    },
    saveTunnel(id, mode, tunnel) {
      const profile = find(id);
      if (!profile.accountKey) throw new Error("Verify the ChatGPT account before binding a tunnel");
      if (!TUNNEL_ID_RE.test(tunnel?.tunnelId)
        || typeof tunnel.runtimeKeyFile !== "string"
        || !path.isAbsolute(tunnel.runtimeKeyFile)) {
        throw new Error("Invalid tunnel credentials for account binding");
      }
      if (data.profiles.some(other => Object.entries(other.tunnels).some(([otherMode, bound]) =>
        (other.id !== id || otherMode !== mode) && bound?.tunnelId === tunnel.tunnelId))) {
        throw new Error("This Tunnel is already bound to another account or interaction mode");
      }
      const destination = keyPath(id, mode);
      const releaseClaim = claim("tunnels", tunnel.tunnelId);
      const previous = profile.tunnels[mode];
      const previousBytes = fs.existsSync(destination) ? fs.readFileSync(destination) : null;
      try {
        const bytes = fs.readFileSync(tunnel.runtimeKeyFile);
        if (bytes.length < 20 || bytes.length > 64 * 1024) throw new Error("Tunnel runtime key is invalid");
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        writePrivateFileAtomic(destination, bytes);
        profile.tunnels[mode] = { tunnelId: tunnel.tunnelId };
        persist();
      } catch (error) {
        if (previous === undefined) delete profile.tunnels[mode];
        else profile.tunnels[mode] = previous;
        if (previousBytes) writePrivateFileAtomic(destination, previousBytes);
        else fs.rmSync(destination, { force: true });
        releaseClaim();
        throw error;
      }
      if (previous?.tunnelId !== tunnel.tunnelId) releaseOwnedClaim("tunnels", previous?.tunnelId);
      return this.binding(id, mode);
    },
  };
}

function assertActiveTunnelBinding(store, profileId, config) {
  if (store.active().id !== profileId) throw new Error("Selected ChatGPT account changed during routing");
  const binding = store.binding(profileId);
  const tunnel = config?.automaticTunnel || config?.tunnel;
  if (!binding || config?.mode !== "full" || !tunnel || tunnel.tunnelId !== binding.tunnelId) {
    throw new Error("Selected ChatGPT account has no matching active Tunnel; configure its Tunnel before sending");
  }
  const boundKey = fs.readFileSync(binding.runtimeKeyFile);
  const activeKey = fs.readFileSync(tunnel.runtimeKeyFile);
  if (boundKey.length !== activeKey.length || !timingSafeEqual(boundKey, activeKey)) {
    throw new Error("Active Tunnel key does not match the selected ChatGPT account");
  }
  return true;
}

module.exports = {
  LEGACY_PROFILE_ID,
  assertActiveTunnelBinding,
  createAccountStore,
  identityFromSession,
  partitionForProfile,
};
