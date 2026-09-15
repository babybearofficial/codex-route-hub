# Integrated routing fork

This fork combines `codex_routing` with Codex Web GPT 5.0.6. The native launcher owns activation, restoration and runtime cleanup. It does not restart Codex App.

## Entry points

- Native launcher: Configuration → **启动配置** → **启动路由 / 停止路由**. The original status cards, refresh controls and bounded logs are integrated here. Settings links to this page and distinguishes application preferences from route activation.
- macOS Python compatibility GUI: `./scripts/codex-route gui` from the repository root.
- CLI: `./scripts/codex-route on|off|status|sync|watch`.
- The original `/Users/wickedmc/all_codes/codex_routing` entry points forward to `routing/codex_routing` while this checkout exists.

The native launcher stays available as the control panel when routing is off. Its Responses daemon, tunnel, restart timers and Codex connection are stopped/restored. It retains the user's browser profile for the next activation.

On waits for browser refresh and migration, requires the owned runtime to be ready and runs doctor. Off uses the official journal to restore the pre-activation connection, Voice and managed options. A custom provider URL is preserved. Recovery records are not active connections; they stay under `codex/routing-history` in the private Web GPT home. Whole-file hash matching prevents reusing a stale baseline after edits made while off.

The local control API uses the existing owner-only launcher descriptor and Bearer token. The token is never printed. A missing integrated API is an error, not permission for a second controller to start. The original pre-integration installed app still uses the legacy compatibility path until the integrated app is built and installed.

## Validation

```sh
node --test launcher/tests/routing-switch.test.cjs launcher/tests/routing-control.test.cjs launcher/tests/runtime-supervisor.test.cjs launcher/tests/runtime-host.test.cjs launcher/tests/state.test.cjs launcher/tests/renderer-wiring.test.cjs
PYTHONPATH=routing python3 -m unittest discover -s routing/tests -v
```

The user authorized compilation on September 13. Use the pinned Bun 1.4.0 on PATH for build scripts, install locked dependencies, then run `bun run --cwd launcher build` and `bun run --cwd launcher package:mac`. The full launcher test suite includes localization tests. See `routing-validation.md` for actual results.

Source tests are not installed-app validation. A build/package and an end-to-end GUI, model list and connector check remain separate gates. Do not quit Codex App until the integrated build has been validated and a catalog refresh is actually required. Upstream automatic binary updates are disabled for this fork so they cannot overwrite the integrated controller.

New installations default to routing off. Opening the application does not install a route. Explicit model/MCP installation also invokes the same routing controller to verify activation. Closing to the tray preserves the current route state; explicit stop restores the previous connection while keeping the control panel open.

Tunnel-client 0.0.12 may report a ready runtime with `live_runtime.found=false`. Health URL discovery first uses local inventory and falls back to alias status with a bounded 20-second deadline, then verifies the loopback health and MCP endpoints. The previous five-second deadline was shorter than observed control-plane lookup latency.

MCP connection and runtime verification depend on an installed, enabled route, not on a restarted Codex model picker. The model catalog refresh indicator remains separate so current Codex work can finish before any restart.
