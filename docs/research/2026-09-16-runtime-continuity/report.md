# Runtime continuity repair — 2026-09-16

Source baseline: 7e518b4 (codex/integrated-routing). Changes are uncommitted.

## Confirmed failure chain

The referenced task's final screenshots show Tunnel health URL discovery timing out after 20 seconds and cleanup refused because HTTP turns remain active. Launcher log readback on this date confirms the keeper observed proxyHealthy=true at 05:17:41 UTC; subsequent recovery repeatedly failed discovery. At 05:19:48 cleanup no longer reported active-turn refusal, and by 05:20:11 the keeper observed proxyHealthy=false.

The source starts/rechecks Tunnel before the Responses daemon and invokes whole-runtime cleanup when either acquisition fails. Thus a working model-catalog listener is drained and stopped as soon as its turns become idle during an unrelated Tunnel discovery failure. This is consistent with the observed Custom label; no client-side model-manager trace was collected to prove every internal UI transition.

The generated JSON-format .yaml Tunnel profile declares a local health.url_file, but discovery previously skipped that publication and fell back to a status command that can wait for the remote control plane. The current runtime is stopped and its health publication is absent; the previous publication's existence at failure time is not established.

## Changes

- Start/retain the Responses daemon and its monitor independently of Tunnel readiness. Each component handles its own acquisition cleanup; a Tunnel error does not drain the working catalog daemon.
- Prefer a loopback URL published by the configured local profile, while requiring a live health probe and retaining MCP diagnostics verification. Fall back to bounded status discovery when necessary.
- Reuse an endpoint for the same owned Tunnel process. Unknown inventory or unavailable diagnostics do not authorize stopping a ready alias; retained aliases continue monitoring and endpoint discovery. Confirmed unhealthy MCP remains a failure path.
- Recovery retries adopt an existing retained alias instead of repeatedly forcing a restart. Existing keeper backoff and explicit stop behavior remain covered by regression tests.
- Invalidate the UI's previous catalog verification when the proxy is unreachable or the managed route is no longer effective.
- Update AGENTS.md with the scoped continuity and acceptance contract.

## Verification

Direct execution only, no compilation/build/package:

`node --test launcher/tests/*.test.cjs`

341 tests: 340 passed, zero failed, one Linux AppImage-specific test skipped on macOS. Added seven regression cases covering repeated failures/recovery, unavailable diagnostics/inventory, endpoint reuse, valid and unhealthy local URL publication, and catalog evidence invalidation. Full existing launcher tests include stop, drain, ownership, restart and routing behavior.

`git diff --check`: passed.

## Remaining acceptance

SOURCE / ISOLATED TESTS: PASS.
INSTALLED APPLICATION / REAL CLIENT / SLEEP-WAKE / EXTENDED RUN: NOT_RUN.

No app package was built or replaced and no application was restarted. User instructions prohibit autonomous compilation; repository AGENTS.md also requires explicit permission for build/package. The existing stopped production runtime was preserved.

After authorized packaging/install, verify the selected ChatGPT.app client receives Web model rows, then demonstrate Tunnel observation failure cannot interrupt repeated model-catalog responses. Verify actual model selection/turn execution, network recovery and sleep/wake, and confirm explicit stop restores the original route and prevents keeper reactivation. Do not claim indefinite availability from bounded tests; authentication expiry and external service outages remain distinct from local continuity.
