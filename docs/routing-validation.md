# Routing integration validation — 2026-09-13

## Verified

- Fork created at `babybearofficial/codex-chatgpt-web`, based on upstream `e85e369` (5.0.6).
- Native routing, IPC wiring, authenticated loopback control, supervisor, host, persistence and existing non-compiling CJS regression tests: **294 passed**, **1 skipped** (Linux-only AppImage process identity).
- Python routing and compatibility protocol: **58 passed**.
- The modified native routing/HTTP/wiring subset was rerun after final metadata/state handling changes and passed.
- Native routing stress test: **50 enable/disable cycles**, one retained transition at a time; its in-flight reference clears after success and failure.
- Hidden Python GUI test before source migration: **25 create/operate/destroy cycles**, operation threads return to one main thread, logs stay at <=400 lines. Live Python allocations sampled at cycles 5/15/25 were 9,557/10,985/12,204 bytes. This is bounded-run evidence, not a guarantee about third-party Electron memory under arbitrary workloads.
- Official 5.0.6 CLI in an isolated directory restored a custom original provider URL and unrelated settings **byte-for-byte** after connect/disconnect.
- Live legacy runtime was stopped and previous config restored; no Web GPT runtime PIDs remain. Codex App was not stopped or restarted.
- New-file manifest checked for unexpected data artifacts and credential-like tokens; no runtime configuration, private descriptors or account data included.

## Not run

- Application compilation, packaging, installation and new renderer execution: **NOT_RUN**, per the user's no-unrequested-build instruction.
- Upstream localization tests call `typescript.transpileModule` and were excluded from the no-build run.
- Full packaged-app end-to-end verification and remote ChatGPT connector attachment: **NOT_RUN** for the integrated build. One legacy runtime start passed doctor, but later repeat attempts exposed upstream 5-second tunnel discovery timeouts. That is not acceptance evidence for the new build.

Temporary Electron npm test dependency was installed with `--ignore-scripts`. No Electron binary download/install hook, TypeScript compilation, runtime bundle build or app packaging was executed.

Before asking the user to refresh/restart Codex App, obtain authorization for the integrated application build, validate enable/off/enable through the packaged GUI, verify owned proxy/tunnel and model-list readback, then verify the remote connector as applicable. Current Codex work must remain running during this process.
