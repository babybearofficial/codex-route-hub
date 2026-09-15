# Integrated Codex Web GPT / codex_routing

- This fork integrates `/Users/wickedmc/all_codes/codex_routing` into the native launcher. Keep runtime ownership in the launcher; Python is a compatibility client.
- Implement code first, then test. Do not compile/build/package Node.js, TypeScript or Rust without explicit user permission. Direct `.cjs` Node tests and Python tests are allowed; never invoke build hooks implicitly.
- The user has authorized a controlled Codex restart in the activation pipeline. Complete implementation and isolated verification before any live-session restart. The user verified the restart target as /Applications/ChatGPT.app, whose bundle ID is com.openai.codex. Match this exact path and bundle identity; never kill helpers or other applications. Never take desktop focus intentionally.
- Off restores the configuration from immediately before activation, not factory defaults. Preserve unrelated settings and keep recovery journals on conflicts.
- Verify runtime ownership, browser auth and tunnel readiness separately from remote connector binding.
- Bound pending operations, buffers, logs, timers, listeners and child process lifetimes. Test repeated enable/disable and failure paths.
- Do not log, commit, or publish credentials, browser descriptors, runtime configuration, account data or captured private logs.
- Origin is the user's fork; upstream is miuuyy/codex-chatgpt-web. Work on codex/* branches.
