# Routing integration validation — 2026-09-15

## Source and build

- Fork: `babybearofficial/codex-chatgpt-web`, branch `codex/integrated-routing`, upstream base `e85e369` (5.0.6).
- Native startup submenu and configuration UI implemented; source keeps the application running when routing stops.
- Launcher tests: **302 passed, 1 skipped** (Linux-only AppImage process identity).
- Python compatibility: **58 passed**. Runtime integration/tunnel/lifecycle subset: **73 passed**.
- Root and renderer TypeScript checks passed. Renderer and native runtime bundle built with pinned Bun 1.4.0.
- macOS arm64 package built and ad-hoc signature verified. Final installed-build checks are recorded below after execution.

## Real isolated acceptance

- Separate persistent core, launcher and CODEX_HOME directories; the live Codex configuration was not used for activation. Codex App was not stopped or restarted.
- The old five-second tunnel lookup failure reproduced. Local-only discovery also reproduced a real client response of `runtime_state=ready` and `live_runtime.found=false`; the corrected bounded status fallback passed repeated real activation.
- Two source-instance GUI activations passed all local doctor checks: authenticated browser, installed model route, launcher process ownership, Responses proxy, tunnel ownership and readiness.
- Browser-side verification found the ChatGPT connector `Codex Native2`. Connector availability is not a proof that a particular remote tool call reached this tunnel.
- Stop succeeded. The second stop restored the immediate pre-activation configuration byte-for-byte, and the live Codex config remained unchanged during each action.
- During first installation, a Codex capability probe updated an unrelated marketplace timestamp in the isolated configuration. Official restoration preserved that unrelated change. It was not a residual Web GPT route.

## Resource checks

- Native transition stress: 50 enable/off cycles, one retained operation maximum, cleared in-flight reference on success and failure.
- Native renderer: 60 page mount/unmount cycles. Collected JS heap at 10/30/60 cycles: 7,009,752 / 7,204,432 / 7,294,312 bytes. Backing storage remained approximately 569 KB; embedder heap did not grow monotonically. Logs retain at most 300 rows; refresh has one serialized request and a timer cancelled on unmount.
- Legacy Python GUI: 25 create/operate/destroy cycles; threads return to one main thread and logs stay at <=400 lines.
- These are bounded-run observations, not an absolute claim about arbitrary third-party Electron or browser workloads.

## Deployment acceptance

- Final signed build installed at `/Applications/Codex Web GPT.app`; the previous app was backed up privately before replacement.
- Confirmed acceptance process executable is the installed application and `snapshot.packaged=true`.
- Packaged GUI activation passed all local runtime checks. Browser-side connector verification passed again.
- MCP page: no premature-restart blocking banner, verification button enabled with `codexCatalogVerified=false`. Settings navigation to Startup Configuration passed.
- Authenticated model readback using the installed Codex CLI version 0.147.0 returned **11 models**, including **5 ChatGPT Web models**. A preliminary request with an obsolete 0.114.0 version was rejected by the upstream catalog and was not treated as acceptance.
- Final packaged off returned success and restored the immediate pre-activation config byte-for-byte; current Codex configuration remained unchanged.
- Normal user profile reopened in the background with routing disabled. Native API reports `enabled=false`, `busy=false`, `runtimeReady=false`, `runtimeStatus=stopped`; no listener remains on 17841.
- Generated isolated profiles and copied credentials were removed after verification; only sanitized receipts/screenshots remain in ignored `launcher/artifacts`. The old application ZIP backup is retained privately.
