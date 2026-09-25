# Codex Route Hub independence and repair plan

**Goal:** Make Codex Route Hub an independent second-development repository, repair the observed browser-session failure, and bound disk use without changing multi-account or multi-bridge ownership.

**Architecture:** Keep the existing launcher-owned runtime and per-account bridge state. Port only upstream browser compatibility changes that explain the observed failure. Point release discovery at this project's releases. Keep application replacement transactional and remove stale installation copies only after checking their bundle identity.

| Situation | Decision | Expected result |
| --- | --- | --- |
| The fork's default branch and package metadata still identify the original project | Rename and detach the GitHub repository, fast-forward `main` to the integrated branch, and update project metadata while crediting upstream | The standalone repository opens on the multi-account implementation and cannot auto-update from the original project |
| The installed 5.0.8 launcher reports that a Temporary Chat surface is unavailable | Compare its composer detection with upstream 6.1.0; port the exact new structural selector to both the launcher and browser worker | A ready composer in the current ChatGPT layout is recognized without relaxing login checks |
| Five old 5.0.8 app bundles and six runtime versions occupy disk | Verify bundle IDs and runtime ownership, delete known stale copies, and make future successful installations prune old versions | Only the active app and active runtime version remain; rollback is preserved during replacement |
| A new source build is required to affect the installed app | Wait for the user's explicit build and install authorization required by `AGENTS.md` | Source changes can be verified with allowed tests; live app verification follows only if authorized |

## Steps

1. Record current branch, remote, installed bundle identity, application-copy sizes, and runtime-version inventory.
2. Update repository metadata and the launcher's release endpoint/asset validation. Add direct `.cjs` tests for release routing.
3. Port the current ChatGPT composer selector and add direct `.cjs` browser-host coverage. Preserve strict session and surface checks.
4. Add bounded, identity-checked cleanup for installation leftovers and runtime versions. Remove verified old local bundles and versions.
5. Run direct `.cjs` and Python tests plus shell/static checks; do not build Node.js/TypeScript/Rust without explicit authorization.
6. Rename and detach the GitHub fork, fast-forward the new repository's `main`, push atomic commits, and re-check fork state and default branch.
7. If authorized, build and install the launcher, then verify the original error path without taking desktop focus.

## Observed results

| Situation | Decision | Result |
| --- | --- | --- |
| GitHub did not expose fork detachment to the available owner session | Mirror every branch and tag into a new repository, rename the old fork, then assign `codex-route-hub` to the standalone repository | The official repository is `babybearofficial/codex-route-hub`, with `isFork: false`, and both `main` and `codex/integrated-routing` contain the atomic fixes. The old fork is archived under `codex-chatgpt-web-upstream-fork`. |
| Upstream 6.1.0 recognizes a new ChatGPT composer | Port the exact structural selector to the launcher probe and browser worker without changing route ownership | Both paths accept the new composer in isolated tests. The broader upstream UI and feature migration remains separate from this focused repair. |
| The screenshot error persisted after installation | Inspect only structural page state through the launcher's own loopback browser target | ChatGPT redirected the embedded session to `/auth/login`; there was no composer. The installed app now reports a specific sign-in action instead of the ambiguous old error. Completing the login requires the account owner. |
| Application copies and runtime bundles consumed disk | Delete five identity-verified historical `.app` copies and prune old runtime versions after validating the active package | One current `.app` and one current runtime version remain. Available disk increased from about 13 GiB to 16 GiB; future successful updates clean their staging files. |
| Local verification passed but GitHub CI found platform differences | Accept CRLF in the version check and align the Linux AppImage fallback path with the Route Hub identity | Both fixes are committed separately; the new cross-platform CI run is the final gate. |
