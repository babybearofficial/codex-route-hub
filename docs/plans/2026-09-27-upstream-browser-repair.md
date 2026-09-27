# Browser and model repair comparison

Reference: [miuuyy/codex-chatgpt-web 6.1.1](https://github.com/miuuyy/codex-chatgpt-web/commit/a13cd09), checked 2026-09-27. Integration branch starts at `d6282c2` and includes the separately committed native capacity retry repair.

| Observed situation | Decision after comparison | Required result |
| --- | --- | --- |
| One saved instance has all account capability flags false while the other has Pro enabled; both serve successful model catalogs. | Port the upstream 6.1.0/6.1.1 model control selectors, full inspection budget, atomic slider snapshot and lock checks. | Delayed or changed controls cannot silently cache a Pro account as Luna-only. |
| Sync currently restarts the client against the same cached capability snapshot. | Refresh the selected account's capability evidence as part of sync, then restart its owned runtime and client with recovery on failure. | Sync publishes a newly verified account-specific catalog. |
| The fork observes legacy ChatGPT turn, connector, send and response elements; upstream now recognizes grouped turns and Activity before an answer. | Port the browser compatibility changes and corresponding captured DOM tests, keeping the existing model identities. | Submission, activity, streaming and completion work with both supported layouts. |
| Live inspection confirms Pro on both accounts; actual sending succeeds on the selected account but the hidden account's effort control lies outside its viewport. | Port upstream 6.1.0 primary-view device emulation, including resize/navigation invalidation and manual-mode exclusion. | Background account inspection and sending retain an operational viewport without foregrounding the app. |
| Upstream also changes model families, usage tracking and saved chats. | Defer these unrelated features from this repair. | Existing task model identities and context limits remain stable. |
| Route Hub owns separate browser partitions, profiles, ports, tunnels, account records and client lifecycles. | Retain the fork's ownership and multi-account modules; review every port in shared files. | Two saved accounts continue to run independently, with no cross-account session or tool routing. |

Verification must distinguish source tests, packaged smoke and installed account checks. Do not record credentials, private transcripts or account descriptors here.

The maintained feature inventory is [上游功能采用清单](../upstream-features.zh-CN.md). It separates inherited features, selectively ported fixes, Route Hub features and deferred upstream changes.

## Verification results

- Full `bun run verify` passed with Bun 1.4.0: 767 root tests passed / 9 skipped; 407 launcher tests passed / 1 skipped; audits, version checks, type checks, renderer build and relocatable runtime smoke passed.
- The later hidden-primary viewport addition passed the focused browser-host and routing-switch run: 146 tests passed.
- Real headless Chromium passed all 8 turn-binding and effort-control tests.
- Source inspection of both saved account partitions verified authentication and Sol / Extra High / Pro capability. The selected account completed an actual browser smoke response.
- The hidden account initially reproduced an out-of-viewport effort selector in the installed host. Repeating the source smoke with the explicit viewport used by the fix passed; the temporary emulation was cleared and the CDP connections were closed.
- The current macOS arm64 5.0.12 ZIP was rebuilt after both fixes. Deep/strict signature validation and isolated packaged startup passed: `PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`.
- The archive's nine checked launcher modules match source byte-for-byte, including the new viewport/sync fixes and the account, context, batch bridge, Tunnel, named instance and client lifecycle modules.
- Removed a 600 MiB isolated staging directory left by an interrupted earlier package smoke after verifying no process still used it. The current package script and smoke both cleaned their own staging.

## Activation boundary

The user's final instruction is to complete the remaining work and compile **without affecting the current routes**. The running 5.0.11 app and its two routes therefore remain in place. No drain, route stop, client restart, application replacement or deferred installer was launched.

The 5.0.12 archive is ready for a later activation window. Installed-app acceptance must then separately confirm both account catalogs include their available Pro entry, per-account sync updates capability evidence, both background bridges answer, and stopping one account leaves the other running. Source tests and the isolated package check do not claim that these installed-app checks have already happened.
