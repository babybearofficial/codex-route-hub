const { createHash } = require("node:crypto");
const { partitionForProfile } = require("./accounts.cjs");

function profileIdForInstance(name) {
  if (!name) return "default";
  return createHash("sha256").update(`route-hub-instance:${name}`).digest("hex").slice(0, 32);
}

function partitionForInstance(name, launcherProfile = "production") {
  if (!name) return partitionForProfile("default", launcherProfile);
  return partitionForProfile(profileIdForInstance(name), launcherProfile);
}

class HubContexts {
  constructor() {
    this.contexts = new Map();
    this.activeId = null;
  }

  add(context) {
    if (!context?.id || this.contexts.has(context.id) || !context.accountStore) {
      throw new Error("Duplicate or invalid Route Hub account context");
    }
    this.contexts.set(context.id, context);
    if (this.activeId === null) this.activeId = context.id;
    return context;
  }

  get(id = this.activeId) {
    const context = this.contexts.get(id);
    if (!context) throw new Error("Route Hub account context does not exist");
    return context;
  }

  selected() { return this.get(); }

  select(id) {
    this.get(id);
    this.activeId = id;
    return this.snapshot();
  }

  active() { return { ...this.selected().accountStore.active(), id: this.activeId }; }
  profile(id) { return { ...this.get(id).accountStore.active(), id }; }
  binding(id, mode) { return this.get(id).accountStore.binding("default", mode); }
  partition(id) { return this.get(id).partition; }
  bindIdentity(id, user) { return this.get(id).accountStore.bindIdentity("default", user); }
  reserveTunnel(id, mode, tunnelId) {
    return this.get(id).accountStore.reserveTunnel("default", mode, tunnelId);
  }
  saveTunnel(id, mode, tunnel) {
    return this.get(id).accountStore.saveTunnel("default", mode, tunnel);
  }

  snapshot() {
    return {
      activeProfileId: this.activeId,
      profiles: [...this.contexts.values()].map(context => {
        const profile = context.accountStore.snapshot().profiles[0];
        const authenticated = context.browserHost?.snapshot().authenticated === true;
        return {
          id: context.id,
          label: profile.label === "Primary account" ? context.id : profile.label,
          identified: profile.identified,
          tunnelConfigured: profile.tunnelConfigured,
          online: authenticated,
        };
      }),
    };
  }
}

module.exports = { HubContexts, partitionForInstance, profileIdForInstance };
