# Codex Route Hub — integrated routing fork

Application clones are managed by the independent [MultiCodex project](https://github.com/mahdi-salmanzade/MultiCodex). Route Hub manages browser partitions and routing, and calls the selected application's launch boundary when a route change needs a restart. Each such launch now supplies its own Codex home and desktop browser directory, preventing a Hub started from a clone from passing that clone's login context to the official application. The shared Hub defaults to `~/.codex`; use `CODEX_ROUTE_HUB_CODEX_HOME` for an explicit default-home override. Named instances retain their registered homes.

This fork combines `codex_routing` with Codex Web GPT 5.0.6. The native launcher owns activation, restoration and runtime cleanup. It does not restart Codex App.

## Entry points

- Native launcher: Configuration → **启动配置** → **启动路由并重启 Codex / 停止路由并恢复原连接 / 同步模型到 Codex**. The status cards report live evidence, and the bounded logs are integrated here. Settings links to this page and distinguishes application preferences from route activation.
- macOS Python compatibility GUI: `./scripts/codex-route gui` from the repository root.
- CLI: `./scripts/codex-route on|off|status|sync|watch`.
- The original `/Users/wickedmc/all_codes/codex_routing` entry points forward to `routing/codex_routing` while this checkout exists.

The native launcher stays available as the control panel when routing is off. Its Responses daemon, tunnel, restart timers and Codex connection are stopped/restored. It retains the user's browser profile for the next activation.

On waits for browser refresh and migration, requires the owned runtime to be ready and runs doctor. Off uses the official journal to restore the pre-activation connection, Voice and managed options. A custom provider URL is preserved. Recovery records are not active connections; they stay under `codex/routing-history` in the private Web GPT home. Whole-file hash matching prevents reusing a stale baseline after edits made while off.

The local control API uses the existing owner-only launcher descriptor and Bearer token (`/v1/routing/status|set|sync`). The token is never printed. A missing integrated API is an error, not permission for a second controller to start. The original pre-integration installed app still uses the legacy compatibility path until the integrated app is built and installed.

## Continuous routing

`routingDisabled` in the launcher state is the saved user intent and nothing else. What Codex actually reads is observed from the journal plus the top-level `openai_base_url` in `config.toml` (`routeActive`), and what the proxy actually does is observed from `/healthz` (`proxyHealthy`). `runtimeReady` is false whenever the last probe saw the proxy failing, even if the ownership file still says ready.

While a route is in effect, the switch runs a **keeper** (one unref'd 15 s timer, one in-flight observation): it verifies ownership state, proxy health and route presence, records catalog evidence, and when the supervisor has given up (`failed`), the runtime is `stopped`, a transition has stalled for more than three minutes, or a ready proxy has stopped answering for two consecutive ticks, it calls `startIfConfigured()` again with backoff 30 s → 60 s → 120 s → 300 s. It never edits the Codex configuration: a route the user removed while enabled is reported as "已启用，但路由未生效", not re-installed. `needs-setup`, `external` and `not-configured` are reported, not retried. The keeper also runs while the intent is off but the managed route is still in the config (an interrupted off), so Codex is never left pointing at a proxy nobody starts.

The supervisor has a **daemon monitor** symmetrical to the tunnel monitor: every 10 s it checks the owned proxy's `/healthz` identity; three consecutive failures stop the child and hand it to the ordinary crash-recovery path. A refused drain (a Codex turn still active during off) now leaves the runtime in service *with* its monitors running.

`powerMonitor` `resume` and `unlock-screen` call `RoutingSwitch.onSystemResume({ event })`: both monitors probe immediately (thresholds unchanged), and after a 5 s settle the keeper re-observes. Only a real `resume` also refreshes the saved ChatGPT session (automatic mode only; refused while a turn or another browser operation is active); a screen unlock never touches the embedded browser surface. Repeated wake events replace the single pending timer.

## Startup, off and sync semantics

- **Startup with on intent** re-establishes the runtime and route. Codex is restarted only when the route must actually change; a route already in effect leaves the running Codex session alone. If Codex refuses to quit at startup the route is still established and `codexRestartRequired` is flagged.
- **Startup with off intent and an active route** (an off interrupted by a crash, a declined quit or a refused drain) finishes the off pipeline.
- **Explicit start** always restarts Codex so it re-reads the route and the catalog. Before the client stage nothing but the intent changes; a declined quit or a failed sign-in check puts the intent back and leaves a route Codex still reads in service. A failure after that point rolls back to off only when routing was not already in effect.
- **Off** gracefully quits the exact `/Applications/ChatGPT.app` client first (its in-flight turns would otherwise block the drain, and it cannot write `config.toml` concurrently), stops the owned runtime, restores the pre-activation configuration, retires the journal and reopens Codex in the background only if it was running, so Codex actually uses the original connection. If the drain or the restore fails, the runtime is brought back for the still-routed config, Codex is reopened, the intent stays off and the cards show "已停用，但配置仍指向代理". Quitting the launcher while routing is already off does not touch Codex.
- **Sync** ("同步模型到 Codex") verifies route and proxy (recovering the runtime once if needed), records the catalog request baseline, restarts Codex, and reports success only after `/healthz` shows a model catalog request newer than the baseline (bounded 60 s wait; otherwise "Codex 已重启，但尚未观察到模型目录请求" and verification continues through the keeper). Catalog evidence after a controlled restart is a request newer than that restart; after a setup change that flags `codexRestartRequired`, a request newer than the change; at a startup that leaves the route untouched, any request since the proxy started.

## Validation

```sh
node --test launcher/tests/routing-switch.test.cjs launcher/tests/routing-control.test.cjs launcher/tests/codex-client-lifecycle.test.cjs launcher/tests/runtime-supervisor.test.cjs launcher/tests/runtime-host.test.cjs launcher/tests/state.test.cjs launcher/tests/renderer-wiring.test.cjs
PYTHONPATH=routing python3 -m unittest discover -s routing/tests -v
```

The user authorized compilation on September 13. Use the pinned Bun 1.4.0 on PATH for build scripts, install locked dependencies, then run `bun run --cwd launcher build` and `bun run --cwd launcher package:mac`. The full launcher test suite includes localization tests. See `routing-validation.md` for actual results.

Source tests are not installed-app validation. A build/package and an end-to-end GUI, model list and connector check remain separate gates. Do not quit Codex App until the integrated build has been validated and a catalog refresh is actually required. Upstream automatic binary updates are disabled for this fork so they cannot overwrite the integrated controller.

New installations default to routing off. Opening the application does not install a route. Explicit model/MCP installation also invokes the same routing controller to verify activation. Closing to the tray preserves the current route state; explicit stop restores the previous connection while keeping the control panel open.

Tunnel-client 0.0.12 may report a ready runtime with `live_runtime.found=false`. Health URL discovery first uses local inventory and falls back to alias status with a bounded 20-second deadline, then verifies the loopback health and MCP endpoints. The previous five-second deadline was shorter than observed control-plane lookup latency.

MCP connection and runtime verification depend on an installed, enabled route, not on a restarted Codex model picker. The model catalog refresh indicator remains separate so current Codex work can finish before any restart.

## Managed Codex startup

The fork application is named **Codex Route Hub**, bundle ID `dev.babybear.codexroutehub`. The repository and runtime protocol names remain compatible with upstream. Existing private data directories retain their historical names to preserve login and restoration history. Do not run the upstream launcher and this fork against the same data directory concurrently.

The user-confirmed Codex client is `/Applications/ChatGPT.app` with bundle ID `com.openai.codex`. Activation first refreshes and verifies the ChatGPT login, gracefully quits that exact client, prepares and verifies the route, then opens the client in the background and waits for process readback. Refusal or quit timeout does not trigger a forced kill. On setup failure, restoration precedes reopening the previous client. Deactivation uses the same graceful quit → restore → background reopen pipeline so the reopened client uses the original connection; a client that was not running is never launched by off or by a recovery reopen. A transient `ERR_CONNECTION_CLOSED`, `ERR_CONNECTION_RESET` or `ERR_NETWORK_CHANGED` gets one socket reset and fresh navigation retry; cookies and login storage are preserved. Persistent network errors remain errors and do not justify restarting the client before preflight succeeds.

Isolated acceptance may set `CODEX_ROUTE_HUB_TEST_NO_CLIENT_RESTART=1` only with a separate CODEX_HOME; the override is ignored for the actual user Codex home. Production activation always uses the managed restart pipeline on macOS.
