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
