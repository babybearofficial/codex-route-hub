const { redactText } = require("./logging.cjs");
const { assertActiveTunnelBinding } = require("./accounts.cjs");

function routingContexts(contexts, profileIds) {
  if (!Array.isArray(profileIds) || profileIds.length === 0 || profileIds.length > 8) {
    throw new Error("Select between one and eight accounts");
  }
  if (profileIds.some(id => typeof id !== "string" || !id || id.length > 128)
    || new Set(profileIds).size !== profileIds.length) {
    throw new Error("Account selection contains an invalid or duplicate ID");
  }
  return profileIds.map(id => {
    const context = contexts.get(id);
    if (!context?.routingSwitch) throw new Error(`Unknown Route Hub account: ${id}`);
    return { id, context, routingSwitch: context.routingSwitch };
  });
}

function routingStatuses(contexts) {
  return [...contexts].map(([profileId, context]) => ({
    profileId,
    status: context.routingSwitch.status(),
  }));
}

async function startAccountBridge(context) {
  const { accountStore, browserHost, runtimeHost, routingSwitch } = context;
  // The legacy single-profile launcher still owns its original setup flow.
  if (!accountStore || !runtimeHost) return routingSwitch.setEnabled(true);
  const binding = accountStore.binding("default", "automatic");
  if (!binding) throw new Error("Save this account's Tunnel ID and runtime key before starting its bridge");
  await browserHost.assertBoundAccountIdentity();
  const config = runtimeHost.runtimeConfigSnapshot().config;
  let bindingInstalled = false;
  try { bindingInstalled = assertActiveTunnelBinding(accountStore, "default", config) === true; }
  catch { /* A staged key needs a full setup before this account can route. */ }
  if (bindingInstalled) return routingSwitch.setEnabled(true);
  const result = await routingSwitch.install(() => runtimeHost.setupMcp({
    tunnelId: binding.tunnelId,
    trustedRuntimeKeyFile: binding.runtimeKeyFile,
    replace: true,
    interactionMode: "automatic",
  }));
  assertActiveTunnelBinding(accountStore, "default", runtimeHost.runtimeConfigSnapshot().config);
  return result;
}

function namedRoutingControl(context) {
  return {
    status: () => context.routingSwitch.status(),
    setEnabled: enabled => {
      if (typeof enabled !== "boolean") throw new Error("Routing enabled must be boolean");
      return enabled ? startAccountBridge(context) : context.routingSwitch.setEnabled(false);
    },
    sync: () => context.routingSwitch.sync(),
  };
}

async function setRoutingBatch(contexts, profileIds, enabled) {
  if (typeof enabled !== "boolean") throw new Error("Routing enabled must be boolean");
  // Validate the entire selection before any account is changed. Accounts are then handled
  // in order so independent Codex client restarts cannot race over desktop focus or state.
  const selected = routingContexts(contexts, profileIds);
  if (selected.some(({ routingSwitch }) => routingSwitch.inFlight)) {
    throw new Error("Wait for the current account routing operation to finish");
  }
  const results = [];
  for (const { id, context, routingSwitch } of selected) {
    try {
      if (enabled) await startAccountBridge(context);
      else await routingSwitch.setEnabled(false);
      const status = routingSwitch.status();
      const ok = enabled
        ? status.enabled && status.routeActive === true && status.runtimeReady
        : !status.enabled && status.routeActive === false;
      results.push({ profileId: id, ok, status,
        ...(ok ? {} : { error: "Bridge state could not be verified after the operation" }) });
    } catch (error) {
      results.push({ profileId: id, ok: false, status: routingSwitch.status(),
        error: redactText(error instanceof Error ? error.message : String(error)) });
    }
  }
  return { enabled, results };
}

module.exports = { routingContexts, routingStatuses, setRoutingBatch, startAccountBridge, namedRoutingControl };
