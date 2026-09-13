# Integrated routing design

The Python switch used TCP connectivity as readiness and raced the launcher's own setup and runtime processes. Shutdown could also kill a route CLI performing restoration. A separate GUI and supervisor cannot safely share ownership of the same runtime.

The fork makes the Electron RuntimeSupervisor the single owner. `RoutingSwitch` serializes native settings, authenticated loopback requests and startup. Enable waits for saved-session refresh, performs any version migration, establishes the model route and verifies runtime health. Disable drains/stops owned runtime processes, restores the previous configuration using the official journal and persists off intent. Codex App is never restarted.

Inactive journals are archived after verified restoration. A subsequent enable may reuse a journal only if the complete current configuration hash and path match its saved baseline; edits made while off cause fresh setup instead. Restores never replace an entire user config with defaults.

The tunnel's health endpoint is discovered with the official local-only `runtimes cleanup --json` dry run. Only the configured alias and a validated loopback endpoint are accepted. No `--apply` is issued. Remote control-plane lookup latency cannot masquerade as failure of the local daemon.

The Python implementation lives under `routing/`; the former project forwards imports here. Integrated launchers expose authenticated `/v1/routing/status` and `/v1/routing/set`. Once the integrated protocol is registered, absence of its live API cannot silently start a competing controller. Older installed launchers retain an explicit compatibility path.

No unbounded operation queues are created. Native transitions reject contention and release their promise reference; Python uses one worker, one pending action, a bounded event queue and 400 log lines. Existing supervisor owns child lifetimes and timer cleanup. Automatic upstream binary updates are disabled for the integrated fork to avoid silently replacing these changes.

Validation separates source tests, packaged application behavior, model-catalog refresh in Codex App and remote ChatGPT connector binding. Application building and packaging require explicit user authorization in this workspace.
