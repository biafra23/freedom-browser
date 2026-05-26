# Multi-Profile Compatibility Plan

**Date:** 2026-05-25
**Status:** Research and implementation plan
**Scope:** Make Freedom Browser support multiple independent profiles that can be launched in parallel as separate Electron processes.

---

## Executive Summary

Freedom Browser is close to process-per-profile compatibility for regular app data, but several runtime resources are still shared or implicitly reused. The most important failures are node daemon reuse on default ports, dev-mode data directories rooted in the repository, duplicate path resolution in identity code, missing same-profile launch protection, and the Touch ID quick-unlock credential collision.

The recommended implementation is **process-per-profile**:

- one Electron process per active profile
- one `app.getPath('userData')` root per profile
- one identity vault and quick-unlock credential per profile
- one managed Bee/IPFS/Radicle data directory per profile
- one non-default managed port set per profile unless the user explicitly opts into an external/system node
- one lock per profile so the same profile cannot be opened twice against the same SQLite files and node repos
- one durable profile catalog for profile discovery and port assignment, not runtime liveness

Do not attempt in-process multi-profile for the first version. The app uses Electron's default session, process-global service registries, module-level caches, node process globals, and singleton vault state. Supporting multiple active profiles inside one Electron process would require a much larger renderer/main-process refactor.

---

## Goals

- Users can create, name, rename, delete, and launch independent profiles.
- Two different profiles can run at the same time without sharing:
  - browser storage
  - settings/bookmarks/history/favicons
  - identity vaults
  - Touch ID quick-unlock credentials
  - Bee/IPFS/Radicle data directories
  - managed daemon ports
  - logs and crash dumps
- A second launch of the same profile is guarded. The app should focus or reject instead of opening two processes against the same profile data.
- Existing users keep their current profile as the default profile without data loss.
- System/external daemon reuse remains possible per profile and per protocol, but only as an explicit profile setting.
- A durable catalog records profile existence and assigned ports. It is not used as a process lock or daemon liveness source.

## Non-Goals

- Multiple profiles inside one Electron process.
- Syncing, merging, or importing profiles from other machines.
- Shared identity/vaults across profiles.
- Reworking wallet/identity cryptography beyond quick-unlock binding and migration.
- Replacing the existing Bee/IPFS/Radicle manager ownership model.

---

## Architecture Fit

The README defines the main process as owner of node lifecycles, protocol routing, IPC, and persistent data. The renderer is UI that talks to main over IPC. This plan keeps that boundary:

- Profile resolution, path resolution, locks, daemon ports, node startup, and migration live in `src/main/`.
- Renderer changes are limited to profile-management UI and existing IPC calls.
- Shared constants or channel names can live in `src/shared/` if needed.
- No top-level package boundary changes are required.

---

## Current State

### Already Profile-Friendly

- `src/main/index.js` already proves the basic mechanism: `FREEDOM_TEST_USER_DATA` calls `app.setPath('userData', ...)` before most modules are imported.
- Most app stores resolve under `app.getPath('userData')` in packaged builds:
  - settings
  - bookmarks
  - history and favicons
  - publish history
  - Swarm permissions
  - feed store
  - dapp permissions
  - RPC manager API keys
  - token registry
  - network registry
  - Colibri resolver cache
  - wallet balance cache
- Renderer browser storage follows the Electron profile because `session.defaultSession` is backed by `userData`.
- Privileged protocol registration is per Electron process, so `bzz:`, `ipfs:`, and `ipns:` handlers can be registered independently in each profile process.
- Existing `<webview>` usage inherits the active process's `defaultSession`, so webview storage follows the active profile's `userData`.
- There is no app-wide `requestSingleInstanceLock()`, so different Electron processes can currently start.

### Current Shared-Resource Problems

| Area | Severity | Current Behavior | Impact |
| --- | --- | --- | --- |
| Daemon auto-reuse | Blocker | Bee/IPFS/Radicle probe default ports and reuse compatible daemons | Profile B can silently use profile A's node identity, pins, stamps, peers, and storage |
| Managed daemon ports | Blocker | Default ports are shared: Bee `1633`, IPFS `5001`/gateway, Radicle `8780`/P2P | Profiles race for the same loopback ports |
| Dev data directories | Blocker | Dev defaults use repo-root `bee-data`, `ipfs-data`, `radicle-data`, `identity-data` | Dev profiles share node and identity data unless env overrides are set |
| Identity path helpers | Blocker | `identity-manager.js` duplicates Bee/IPFS/Radicle data-dir helpers and ignores some env overrides | Identity injection can write keys to a different directory than the daemon uses |
| Quick unlock | Blocker | Dev quick unlock writes repo-root `identity-data/quick-unlock.dat`; credential has no profile/vault binding | Enabling Touch ID in one profile can overwrite another profile's quick-unlock credential |
| Same-profile double launch | Blocker | No per-profile lock | Two processes can open the same SQLite files and node repos |
| Crash dumps | Medium | `crashDumps` is set to `src/main/crash-reports` | Dumps are not profile-scoped and may target read-only packaged app paths |
| Radicle system node reuse | Medium | System node reuse can use `~/.radicle` implicitly | Profiles can intentionally or accidentally share Radicle identity/storage |
| Module singletons | Medium | Service registry, vault state, node managers, and renderer default session are process-global | Confirms process-per-profile is the right first architecture |
| Dev updater endpoint | Low | Dev update checks use `localhost:8765` | Not a profile isolation blocker, but can add noise during multi-profile dev runs |

---

## Code Anchors

- Early test userData override: `src/main/index.js:21`
- Crash dump path: `src/main/index.js:109`
- Bee data path and daemon detection: `src/main/bee-manager.js:84`, `src/main/bee-manager.js:319`, `src/main/bee-manager.js:397`
- IPFS data path, lock deletion, and daemon detection: `src/main/ipfs-manager.js:71`, `src/main/ipfs-manager.js:100`, `src/main/ipfs-manager.js:352`, `src/main/ipfs-manager.js:438`
- Radicle data path and daemon detection: `src/main/radicle-manager.js:115`, `src/main/radicle-manager.js:345`, `src/main/radicle-manager.js:608`
- Default service ports: `src/main/service-registry.js:50`
- Identity data path: `src/main/identity-manager.js:36`
- Duplicate node data helpers in identity manager: `src/main/identity-manager.js:265`
- Quick unlock credential path: `src/main/quick-unlock.js:19`
- Quick unlock write/read: `src/main/quick-unlock.js:73`, `src/main/quick-unlock.js:111`
- Quick setup Touch ID flow: `src/renderer/lib/onboarding.js:210`
- Touch ID unlock uses returned password: `src/renderer/lib/wallet/vault-unlock.js:129`

---

## Target Model

### Profile Layout

Keep the current user data directory as the default profile for backward compatibility. Named profiles live underneath a profile root managed by the default app data directory.

Example macOS layout:

```text
~/Library/Application Support/Freedom/
  profile-registry.json
  settings.json
  history.sqlite
  identity/
  bee-data/
  ipfs-data/
  radicle-data/
  Profiles/
    work/
      profile.json
      settings.json
      history.sqlite
      identity/
      bee-data/
      ipfs-data/
      radicle-data/
      logs/
      crash-reports/
    testing/
      profile.json
      ...
```

In development, `npm start` should use a separate namespace per checkout:

```text
~/Library/Application Support/Freedom Dev/
  freedom-browser-<hash-of-real-repo-path>/
    profile-registry.json
    Profiles/
      default/
        profile.json
        settings.json
        identity/
        bee-data/
        ipfs-data/
        radicle-data/
      work/
        profile.json
        ...
```

The checkout id should be derived from the real repository root so multiple local clones do not collide by default. The anchor is the realpath of the directory containing `package.json`, not `process.cwd()`, so running from a subdirectory does not create a different dev home. Use `sha256(realRepoRoot).slice(0, 8)` and a readable prefix such as `freedom-browser-<hash>`.

Default profile:

- uses the current `app.getPath('userData')` directory when no profile is specified
- keeps existing data in place
- may get a generated `profile.json` and profile id during migration
- intentionally shares the app data root with app-level files such as `profile-registry.json` for backward compatibility

Named profiles:

- use `Profiles/<profileId>` as `app.getPath('userData')`
- store all profile-owned state below that directory
- have sanitized, immutable ids and mutable display names

Dev profiles:

- are isolated from packaged app profiles
- are isolated per checkout by default
- use `Profiles/default/` even though packaged default profile stays at the app data root; dev is greenfield, while packaged carries legacy data
- are launched naturally with `npm start` and `npm start -- --profile=<id>`
- can be intentionally shared across checkouts only with an explicit full-path override such as `FREEDOM_DEV_HOME`
- do not use repo-root `bee-data`, `ipfs-data`, `radicle-data`, or `identity-data`

### Durable Profile Catalog

The shared registry should be a **profile catalog**, not a runtime ownership table.

It answers durable questions:

- which profiles exist
- where each profile directory is
- which display name to show
- which ports are assigned to each managed node protocol
- which protocols use independent managed nodes vs explicit external nodes

It must not answer volatile questions:

- whether a profile process is currently alive
- whether a daemon is currently alive
- whether a PID can be killed
- whether a daemon should be reused

Those are handled by per-profile locks, direct port checks, and manager-owned child-process state.

Catalog location note:

- The app data root doubles as the default profile directory for backward compatibility.
- `profile-registry.json` is therefore a sibling of default-profile files such as `settings.json`, not conceptually part of the default profile.
- Named profiles live under `Profiles/<profileId>/`.
- Moving the default profile under `Profiles/default/` would be cleaner, but is a higher-risk migration and is not part of v1.

Example catalog:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "default",
      "displayName": "Default",
      "dir": "/Users/florian/Library/Application Support/Freedom",
      "createdAt": "2026-05-25T00:00:00.000Z",
      "lastOpenedAt": "2026-05-25T00:00:00.000Z",
      "nodes": {
        "bee": {
          "mode": "managed",
          "apiPort": 11633,
          "p2pPort": 12633,
          "externalApi": null
        },
        "ipfs": {
          "mode": "managed",
          "apiPort": 15001,
          "gatewayPort": 18080,
          "externalApi": null,
          "externalGateway": null
        },
        "radicle": {
          "mode": "managed",
          "httpPort": 18780,
          "p2pPort": 18776,
          "externalHttp": null
        }
      }
    },
    {
      "id": "work",
      "displayName": "Work",
      "dir": "/Users/florian/Library/Application Support/Freedom/Profiles/work",
      "createdAt": "2026-05-25T00:00:00.000Z",
      "lastOpenedAt": "2026-05-25T00:00:00.000Z",
      "nodes": {
        "bee": {
          "mode": "managed",
          "apiPort": 11634,
          "externalApi": null
        },
        "ipfs": {
          "mode": "managed",
          "apiPort": 15002,
          "gatewayPort": 18081,
          "externalApi": null,
          "externalGateway": null
        },
        "radicle": {
          "mode": "managed",
          "httpPort": 18781,
          "p2pPort": 18777,
          "externalHttp": null
        }
      }
    }
  ]
}
```

Catalog rules:

- Store the catalog in the default app data root, not inside one named profile.
- Capture the default app data root before calling `app.setPath('userData', ...)` for a named profile.
- Create catalog records at profile creation time, before launching the profile.
- Allocate ports at profile creation time and persist them.
- Treat the catalog as the index for the profile picker and port allocation.
- Do not block startup just because the catalog claims another profile has a port. Validate the active profile's assigned ports directly.
- If a profile-local `profile.json` and the catalog disagree, prefer profile-local metadata for that profile and repair the catalog.
- Use atomic writes and a short-lived catalog write lock for create/rename/delete/port-reassignment operations. This lock protects file updates only; it is not a profile runtime lock.

### Profile Metadata

Each profile should have a small metadata file:

```json
{
  "version": 1,
  "id": "work",
  "displayName": "Work",
  "createdAt": "2026-05-25T00:00:00.000Z",
  "lastOpenedAt": "2026-05-25T00:00:00.000Z",
  "nodes": {
    "bee": {
      "mode": "managed",
      "apiPort": 11634,
      "externalApi": null
    },
    "ipfs": {
      "mode": "managed",
      "apiPort": 15002,
      "gatewayPort": 18081,
      "externalApi": null,
      "externalGateway": null
    },
    "radicle": {
      "mode": "managed",
      "httpPort": 18781,
      "p2pPort": 18777,
      "externalHttp": null
    }
  }
}
```

Port assignments should be persisted in both `profile-registry.json` and profile-local `profile.json` so a profile keeps stable endpoints between launches and remains understandable if copied or inspected on its own.

### Node Modes

The node strategy should be explicit and profile-local.

| Protocol Mode | Default | Meaning | Reuse Behavior |
| --- | --- | --- | --- |
| `managed` | Yes | This profile starts its own Bee/IPFS/Radicle from its own data dirs on its assigned ports | Never reuses a compatible daemon just because it answers on localhost |
| `external` | No | This profile connects to user-configured external endpoints | Reuse is intentional and visible |
| `disabled` | Optional | This profile does not start or connect to that node | No daemon startup or probing |

The product default should be `managed`. This gives users the clearest promise: independent profile means independent browser state, vault, node identity, node storage, and managed node ports.

External reuse remains valuable for power users, but it must be opt-in per protocol. A profile configured to use an external endpoint should clearly show that node identity/storage is shared outside the profile boundary.

### Port Assignment

Port allocation should be deterministic enough for support and stable enough for bookmarks, logs, and debugging.

Recommended allocation:

- Freedom-managed nodes should avoid the ecosystem default ports:
  - Bee API/gateway default: `1633`
  - Bee P2P default: `1634`
  - IPFS API default: `5001`
  - IPFS gateway default: `8080`
  - Radicle HTTP default: `8780`
  - Radicle P2P default: `8776`
- Treat daemons on those default ports as external/system-node candidates, not Freedom-managed defaults.
- Allocate managed ports from Freedom-owned profile slots:
  - slot 0/default profile: Bee API `11633`, Bee P2P `12633`, IPFS API `15001`, IPFS gateway `18080`, Radicle HTTP `18780`, Radicle P2P `18776`
  - slot 1: Bee API `11634`, Bee P2P `12634`, IPFS API `15002`, IPFS gateway `18081`, Radicle HTTP `18781`, Radicle P2P `18777`
  - slot 2: Bee API `11635`, Bee P2P `12635`, IPFS API `15003`, IPFS gateway `18082`, Radicle HTTP `18782`, Radicle P2P `18778`
- Development managed nodes should use a separate high range from packaged managed nodes:
  - dev slot 0: Bee API `21633`, Bee P2P `22633`, IPFS API `25001`, IPFS gateway `28080`, Radicle HTTP `28780`, Radicle P2P `28776`
  - dev slot 1: Bee API `21634`, Bee P2P `22634`, IPFS API `25002`, IPFS gateway `28081`, Radicle HTTP `28781`, Radicle P2P `28777`
  - always apply a checkout-derived offset to reduce collisions across simultaneously running local clones
- Recommended dev offset:
  - `checkoutOffset = (parseInt(checkoutHash, 16) % 100) * 10`
  - add `checkoutOffset` to every dev managed base port before applying the profile slot increment
  - still validate and reassign at startup because unrelated local software can bind any port
- Treat catalog/profile-local ports as the profile's desired stable assignment, not a guarantee that the machine has those ports free forever.
- Validate assigned managed ports before starting each protocol.
- If an assigned managed port is busy at startup:
  - do not silently reuse the listener
  - if the listener is this profile's own recoverable stale child process, recover carefully
  - otherwise choose the next free managed slot for that protocol, persist it, then start the node
- Treat multi-port protocols atomically:
  - IPFS API and gateway move together
  - Radicle HTTP and P2P move together
- Persist reassignment to both profile-local `profile.json` and the shared catalog while holding the catalog write lock.
- Auto-reassign before the first successful run of a newly created profile.
- For profiles that have already run successfully, show a user-confirmed reassignment prompt unless headless/test mode requires automatic reassignment.
- Do not treat a busy port as permission to reuse the daemon in managed mode.
- If a compatible daemon is detected on a protocol's default port, offer to configure that protocol as `external` for the active profile.

This avoids the ambiguous question "is localhost:1633 an external node or another Freedom profile?" during normal managed-profile startup. A managed profile never needs to inspect another profile's ports because it already has its own assigned non-default ports.

### Endpoint Resolution

Once Freedom-managed nodes move off ecosystem default ports, no runtime code should treat `1633`, `5001`, `8080`, or `8780` as Freedom-owned fallbacks.

Rules:

- Managed-node endpoints come from resolved profile metadata and the service registry.
- External-node endpoints come from explicit per-profile protocol settings.
- Service-registry endpoint getters should return `null` or an unavailable state when the registry is not hydrated. They must not fall back to ecosystem default ports.
- Renderer and preload code should wait for service-registry hydration or handle unavailable endpoints explicitly.
- Renderer, preload, main-process helpers, and package scripts must not hardcode ecosystem default ports as Freedom-managed endpoints.
- Any developer scripts that intentionally query default ports should be named/described as system/external-node helpers or accept explicit profile endpoint arguments.

### Startup Sequence

The profile bootstrap must happen before logger initialization and before importing modules that may compute profile paths.

Recommended startup order:

1. Import only `electron`, `path`, and minimal profile bootstrap code.
2. Parse `--profile=<id>`, `--profile-dir=<path>`, `FREEDOM_PROFILE`, and test overrides.
3. Capture the default app data root and load or create the durable profile catalog.
4. Resolve the active profile directory, profile-local metadata, per-protocol node modes, and assigned ports.
5. Call `app.setPath('userData', profile.userDataDir)`.
6. Call `app.setPath('crashDumps', path.join(profile.userDataDir, 'crash-reports'))`.
7. Configure profile-scoped env overrides only for legacy modules during migration:
   - `FREEDOM_IDENTITY_DATA`
   - `FREEDOM_BEE_DATA`
   - `FREEDOM_IPFS_DATA`
   - `FREEDOM_RADICLE_DATA`
8. Initialize logger.
9. Acquire the per-profile lock.
10. Import and register the rest of the main-process modules.
11. Run migrations for the active profile only.
12. Start, connect, or skip nodes according to each protocol's mode and assigned runtime config.

### Development Mode

Development launches are frequent and often run from multiple local checkouts. They should be safe by default.

Rules:

- `npm start` is equivalent to `electron .` and should resolve a dev default profile automatically.
- Set `app.name` / `app.setName()` to `Freedom Dev` in dev before electron-log initializes, then set `userData` to the checkout/profile-specific path.
- Dev profiles live under an OS app support directory, not inside the Git checkout.
- The dev profile root is namespaced by the real repo root containing `package.json`:
  - macOS example: `~/Library/Application Support/Freedom Dev/freedom-browser-<checkout-hash>/`
  - Linux/Windows should use the platform-equivalent app data root.
- Derive `<checkout-hash>` as `sha256(realRepoRoot).slice(0, 8)`.
- `npm start -- --profile=work` launches the `work` profile inside that checkout namespace.
- `FREEDOM_PROFILE=work npm start` should behave the same as `npm start -- --profile=work`.
- `FREEDOM_DEV_HOME=/path/to/shared/dev-home npm start` replaces the whole checkout dev home path. It is the explicit escape hatch for intentionally sharing dev profiles across checkouts or symlinked worktrees.
- `FREEDOM_TEST_USER_DATA` still wins for Playwright/live test runs.
- Normal dev launch should not touch packaged `Freedom` userData.
- Normal dev launch should not touch repo-root `identity-data`, `bee-data`, `ipfs-data`, or `radicle-data`.
- Existing repo-root dev data is legacy. Do not auto-migrate it and do not use it by default.
- On dev first launch, if repo-root legacy dirs exist, log a visible warning that they were detected and are no longer used by default.
- If a developer wants repo-root data for a one-off run, require an explicit advanced override rather than making it the default.

Dev updater:

- Keep updater disabled for normal `npm start`.
- Preserve the existing explicit path for updater testing, for example `ENABLE_DEV_UPDATER=true npm start`.
- If dev updater is enabled, use the same updater owner lock concept, scoped to the dev checkout namespace.

### App-Wide Runtime Resources

Profiles are independent, but the installed app bundle is shared. Some app-wide resources must therefore have exactly one active owner across all running profile processes.

Updater:

- The auto-updater should be owned by exactly one running Freedom process, regardless of which profile it is.
- Do not make update checks default-profile-only; users who live entirely in a named profile still need updates.
- Use a short-lived app-level updater owner lock. The first running profile process that acquires it performs update checks/downloads.
- If the updater-owning process quits, another running or future profile process can acquire the updater owner lock.
- Preserve the active `--profile=<id>` or `--profile-dir=<path>` when update-and-relaunch occurs.
- If preserving profile args is not reliable on a platform, disable automatic `quitAndInstall()` for that path until relaunch behavior is explicit.

Catalog writes:

- Catalog create/rename/delete/port-reassignment operations also need a short-lived app-level file lock.
- This protects the catalog file from concurrent edits. It is separate from profile runtime locks and updater ownership.

Preferred lock implementation:

- Use a battle-tested cross-platform lock implementation such as `proper-lockfile`, subject to dependency approval.
- Use it for:
  - per-profile runtime locks
  - catalog write locks
  - updater owner locks
- Avoid a homegrown cross-platform lock unless dependency approval is rejected and the fallback is small, well-tested, and covers macOS, Windows, and Linux.

### macOS Multi-Instance Notes

Process-per-profile still uses one macOS app bundle identity.

Known v1 constraints:

- Dock and menu bar behavior may group all profile processes under one app identity.
- Verify `Info.plist` does not set `LSMultipleInstancesProhibited`.
- Launching another profile on macOS should use a new app instance, for example the packaged equivalent of `open -n -a Freedom --args --profile=<id>`.
- OS-level deep links such as `bzz://`, `ipfs://`, `ipns://`, and `freedom://` may be delivered by LaunchServices to an existing instance rather than the intended named profile.

Recommended v1 rule:

- External OS deep links route to the default profile unless the URL was opened from inside an already-running named profile process.
- Rich cross-profile deep-link routing can be a v2 feature once profile process discovery/focusing exists.

---

## Work Packages

### WP0: Baseline Guardrails

Purpose: make the refactor measurable before behavior changes land.

Tasks:

- Add or extend tests around current path-resolution behavior.
- Capture current defaults for default profile startup.
- Add fixture helpers for temporary `userData` roots.
- Add test coverage for the Touch ID quick-unlock path resolver with mocked `app.isPackaged`.
- Confirm `npm run lint` and relevant tests are green before implementation starts.

Acceptance criteria:

- There are failing or skipped tests that describe the desired profile isolation behavior.
- The default profile still starts with existing data paths.
- No production behavior changes yet.

### WP1: Profile Catalog and Resolver

Purpose: introduce one durable profile catalog plus one early resolver for profile identity, profile directories, per-protocol node modes, and assigned ports.

Tasks:

- Add a main-process profile module, for example `src/main/profile-resolver.js`.
- Add a durable catalog helper, for example `src/main/profile-catalog.js`.
- Capture the default app data root before any named-profile `app.setPath('userData', ...)` call.
- In dev mode, resolve the default app data root to `Freedom Dev/<checkout-id>` instead of packaged `Freedom`.
- Derive `<checkout-id>` from `sha256(realRepoRoot).slice(0, 8)`, where `realRepoRoot` is the realpath of the directory containing `package.json`.
- Treat `FREEDOM_DEV_HOME` as a full-path replacement for the checkout dev home.
- Set `app.name` / `app.setName()` to `Freedom Dev` in dev before logger initialization.
- Parse:
  - `--profile=<id>`
  - `--profile-dir=<absolute-path>` for tests and advanced/manual launch
  - `FREEDOM_PROFILE`
  - existing `FREEDOM_TEST_USER_DATA`
- Define precedence:
  1. `FREEDOM_TEST_USER_DATA` for existing E2E compatibility
  2. `--profile-dir`
  3. `--profile`
  4. `FREEDOM_PROFILE`
  5. default profile
- Sanitize profile ids:
  - lowercase stable id
  - no path separators
  - no `.` or `..`
  - display name stored separately
- Add `profile-registry.json` in the default app data root.
- Treat `profile-registry.json` as a durable catalog:
  - profile ids
  - display names
  - profile directories
  - per-protocol node modes
  - assigned managed-node ports
  - created/opened timestamps
- Do not store PID, heartbeat, lock, or daemon liveness data in the catalog.
- Create missing named profile directories on demand.
- Write or update `profile.json` inside each profile directory.
- Allocate and persist ports when creating a profile with managed node protocols.
- Mirror catalog data into profile-local `profile.json`.
- Prefer profile-local metadata over the catalog if they disagree, then repair the catalog.
- Define profile creation ordering and recovery:
  - write the catalog entry with an atomic rename while holding the catalog write lock
  - create the profile directory and profile-local `profile.json`
  - if the catalog references a missing profile directory on a later startup, recreate the directory and `profile.json` from catalog data
  - if a profile directory exists without a catalog entry, surface it as an unregistered/importable profile in the picker
- Reuse freed port slots after profile deletion, but only after confirming no existing catalog/profile-local metadata currently owns those ports.
- Use atomic catalog writes and a short-lived catalog write lock for profile mutations.
- Set `app.setPath('userData', ...)` before logger and most imports.
- Preserve `FREEDOM_TEST_USER_DATA` behavior for Playwright tests.

Acceptance criteria:

- `Freedom --profile=work` and `Freedom --profile=personal` resolve different `userData` directories.
- `npm start` resolves to this checkout's dev default profile, isolated from packaged userData.
- `npm start -- --profile=work` resolves to this checkout's dev `work` profile.
- Two local checkouts get different dev profile catalogs by default.
- Running `npm start` from a subdirectory still resolves the same checkout dev catalog.
- `FREEDOM_DEV_HOME` points the whole dev home at the supplied path.
- Existing no-flag startup uses the existing default userData directory.
- The default profile has a catalog entry and profile-local metadata without moving existing data.
- A newly created managed profile has stable assigned ports before it launches.
- Partial profile creation states are recoverable.
- Deleting and recreating profiles can reuse freed slots without colliding with existing profile metadata.
- Invalid profile ids are rejected with a clear error.
- The resolver can be unit-tested without launching Electron windows.

### WP2: Centralized Profile Path Module

Purpose: remove duplicated path logic and make every profile-owned path resolve from the active profile.

Tasks:

- Add a shared main-process helper, for example `src/main/profile-paths.js`.
- Expose functions:
  - `getProfileUserDataDir()`
  - `getIdentityDataDir()`
  - `getQuickUnlockCredentialPath()`
  - `getBeeDataDir()`
  - `getIpfsDataDir()`
  - `getRadicleDataDir()`
  - `getProfileCrashDir()`
  - `getProfileTempDir()`
- Honor explicit env overrides in all modes:
  - `FREEDOM_IDENTITY_DATA`
  - `FREEDOM_BEE_DATA`
  - `FREEDOM_IPFS_DATA`
  - `FREEDOM_RADICLE_DATA`
- Change dev defaults to use `app.getPath('userData')`, not repo-root directories.
- Stop using repo-root `identity-data`, `bee-data`, `ipfs-data`, and `radicle-data` as implicit dev defaults.
- Update:
  - `identity-manager.js`
  - `quick-unlock.js`
  - `bee-manager.js`
  - `ipfs-manager.js`
  - `radicle-manager.js`
  - any GitHub bridge temp-dir helpers if they are profile-owned
- Treat existing path env overrides as transitional:
  - keep `FREEDOM_TEST_USER_DATA` for Playwright and live test harnesses
  - keep `--profile` and `--profile-dir` as supported launch inputs
  - remove manager-specific fast paths such as `FREEDOM_BEE_DATA`, `FREEDOM_IPFS_DATA`, `FREEDOM_RADICLE_DATA`, and `FREEDOM_IDENTITY_DATA` once `profile-paths.js` is the sole resolver
- Keep binary paths outside profiles:
  - `bee-bin`
  - `ipfs-bin`
  - `radicle-bin`
  - packaged `resourcesPath` binaries

Acceptance criteria:

- No dev-mode default path writes to repo-root `identity-data`, `bee-data`, `ipfs-data`, or `radicle-data`.
- Existing repo-root dev data is ignored unless an explicit advanced override points at it.
- `identity-manager` injects keys into the same data directories the managers use.
- `FREEDOM_RADICLE_DATA` is supported consistently.
- All path helpers are covered by unit tests.

### WP3: Per-Profile Lock

Purpose: prevent two processes from opening the same profile at once.

Tasks:

- Do not use Electron's global `requestSingleInstanceLock()` as the primary lock because it blocks different profiles too.
- Keep a per-profile runtime lock even though the durable catalog is not a liveness registry. This lock protects the active profile's SQLite files, vault files, and node repos from concurrent access.
- Add a per-profile lock under the active profile directory, for example `<userData>/profile.lock`.
- Prefer `proper-lockfile` or an equivalent cross-platform library, subject to dependency approval.
- Store lock metadata with pid, createdAt, app version, profile id, and heartbeat if the chosen library does not already provide sufficient stale-lock behavior.
- On startup:
  - acquire the active profile lock before opening SQLite stores or starting nodes
  - if locked and live, call `dialog.showErrorBox()` with "Profile is already open" and quit the second process
  - if locked and stale, recover only after validating the pid is gone and heartbeat is old
- Release the lock during clean shutdown.
- Add optional v2 IPC/socket support to tell the existing profile process to focus or open a new window.

Acceptance criteria:

- Profile A and profile B can run in parallel.
- Two launches of profile A do not both continue into app startup.
- The v1 duplicate-profile UX works before any app window exists.
- Stale locks from crashes can be recovered safely.
- IPFS `repo.lock` and Radicle `control.sock` cleanup no longer paper over a live same-profile process.

### WP4: Quick Unlock Isolation and Binding

Purpose: fix Touch ID cross-profile override and make stale credentials detectable.

Root cause:

- `quick-unlock.js` uses repo-root `identity-data/quick-unlock.dat` in dev.
- The credential file stores only encrypted password bytes.
- There is no profile id, vault id, or vault fingerprint to prove the credential belongs to the active profile.

Tasks:

- Move quick-unlock credential path to `profile-paths.getQuickUnlockCredentialPath()`.
- Store the credential under the active profile identity directory in all modes.
- Treat profile/vault binding metadata as the security boundary. On macOS, `safeStorage` and Keychain access are tied to the app bundle, not to a profile, so separate profile files alone are not enough.
- Introduce a versioned credential format:

```json
{
  "version": 2,
  "profileId": "work",
  "vaultId": "uuid-or-random-id",
  "createdAt": "2026-05-25T00:00:00.000Z",
  "encryptedPassword": "base64..."
}
```

- Add a non-secret `vaultId` to vault metadata for new vaults.
- For existing vaults, migrate by generating a `vaultId` the first time profile migration runs.
- On unlock:
  - prompt Touch ID
  - read the credential metadata
  - verify `profileId`
  - verify `vaultId`
  - decrypt the password
  - pass the password to the vault unlock flow only after metadata matches
- If metadata does not match, return a specific result:
  - "Touch ID is enabled for a different profile or vault. Re-enable Touch ID for this profile."
- On vault password change:
  - disable quick unlock, or require the UI to re-enable it with the new password
- On vault deletion:
  - delete quick-unlock credential.
- Migration behavior:
  - legacy raw-buffer credential files are accepted only from the active profile's own credential path
  - after a successful unlock, rewrite as version 2 metadata
  - do not import the old repo-root dev credential automatically

Acceptance criteria:

- Enabling Touch ID in profile B cannot overwrite profile A's credential.
- A copied or stale credential fails before trying to unlock the wrong vault.
- Changing/deleting a vault invalidates quick unlock.
- Quick unlock tests cover path isolation, metadata mismatch, legacy migration, and disable-on-delete.

### WP5: Node Modes and Managed Ports

Purpose: each profile owns its managed nodes and never silently reuses another profile's daemon.

Tasks:

- Read profile runtime configuration from the resolved profile metadata.
- Allocate and persist stable ports in WP1 profile creation:
  - Bee API/gateway
  - Bee P2P
  - IPFS API
  - IPFS gateway
  - Radicle HTTP
  - Radicle P2P
- Managed profiles use Freedom-owned non-default port slots.
- Default profile gets slot 0 by default, not the protocol default ports.
- Named profiles allocate the next available profile slot.
- Dev profiles use the dev managed port range with an always-on checkout-derived offset.
- Protocol default ports are treated as external/system-node candidates.
- Validate assigned managed ports before daemon startup.
- Reassign blocked managed ports by finding the next free managed slot, then persist the new assignment to profile-local metadata and the catalog.
- Reassign protocol port sets atomically for IPFS and Radicle.
- Auto-reassign for profiles that have not completed their first successful node start; require user confirmation for established profiles unless running in test/headless mode.
- Update `service-registry.js` so default ports are defaults, not hard-coded ownership assumptions.
- Change service-registry endpoint getters so an unhydrated registry returns `null` or an unavailable state, never ecosystem default ports.
- Pass resolved profile ports into managers instead of relying on constants.
- Audit and update all hardcoded references to `1633`, `5001`, `8080`, and `8780`:
  - `src/main/preload.js`
  - `src/main/service-registry.js`
  - `src/main/favicons.js`
  - renderer code and internal pages
  - package scripts such as `bee:status`, `ipfs:status`, and `radicle:status`
- Route runtime code through the service registry or resolved profile metadata.
- Rename or parameterize dev scripts that intentionally target default ports so they are clearly external/system-node helpers.
- Write daemon configs from the resolved profile runtime:
  - Bee config/data dir
  - Kubo config/data dir
  - Radicle config/data dir
- Stop silent `detectExistingDaemon()` reuse for managed profile mode.
- Treat compatible daemon detection as mode-specific:
  - `managed`: never reuse; if assigned port is busy, recover own stale process or reassign to a free managed slot
  - `external`: connect only to configured endpoints; show shared/external status
  - `disabled`: do not start or probe
- Do not try to infer "external" by API response alone.
- External/system node mode must be explicit per profile and ideally per protocol:
  - user opts into "Use external Bee/IPFS/Radicle"
  - app records configured endpoints in profile metadata or profile settings
  - UI shows "External" clearly in the Nodes panel
- If a compatible daemon is detected on a protocol default port, offer to configure that protocol as `external` for the profile instead of silently reusing it.
- Shutdown only stops daemons the current process started.
- Keep dev updater disabled unless `ENABLE_DEV_UPDATER=true`; when enabled, it uses the same owner-lock model scoped to the dev checkout namespace.

Acceptance criteria:

- Profile B never reuses profile A's Bee/IPFS/Radicle just because it answers on `127.0.0.1`.
- Two named profiles can start managed Bee/IPFS/Radicle simultaneously with distinct data dirs and ports.
- External/system daemon reuse still works when explicitly configured.
- A busy assigned port in managed mode results in persisted reassignment or a clear user-confirmed conflict path, not silent reuse.
- The catalog and profile-local metadata stay in sync after port reassignment.
- Freedom-managed nodes do not bind the ecosystem default ports by default.
- Runtime code never falls back to ecosystem default ports as Freedom-managed endpoints before service-registry hydration.
- Node status UI shows the active endpoint and mode accurately.

### WP6: Identity Injection and Node Data Consistency

Purpose: ensure derived node identities are written to the correct profile-owned data directories.

Tasks:

- Replace identity-manager duplicate helpers with `profile-paths` calls.
- Ensure Bee swarm key injection reads/writes the active profile Bee data dir.
- Ensure IPFS identity injection reads/writes the active profile IPFS data dir.
- Ensure Radicle identity setup reads/writes the active profile Radicle data dir.
- Ensure `isBeeIdentityInjected()`, `isIpfsIdentityInjected()`, and Radicle checks use the same paths as node startup.
- Add tests where all four env overrides are set and identity injection uses the override paths.

Acceptance criteria:

- A profile launcher that sets data paths cannot split identity injection and daemon startup across different directories.
- Fresh profile identity setup creates all node identities under that profile only.
- Switching profiles does not change or overwrite another profile's node identity.

### WP7: App Storage, Logs, Crash Dumps, and Temp Files

Purpose: close remaining profile-scoped storage gaps and make app-scoped resources safe with multiple running profiles.

Tasks:

- Set `crashDumps` to `path.join(app.getPath('userData'), 'crash-reports')`.
- Confirm `electron-log` resolves under the active profile after the profile bootstrap.
- Add profile id to log messages during startup.
- Gate `initUpdater()` behind an app-level updater owner lock so exactly one running profile process checks/downloads updates.
- Store the updater owner lock in the app data root beside `profile-registry.json`, not inside any profile directory.
- Preserve active profile launch args across update relaunch:
  - `--profile=<id>`
  - `--profile-dir=<path>`
- If a platform cannot preserve relaunch args reliably, avoid automatic `quitAndInstall()` until the behavior is explicit and tested.
- Audit temp dirs:
  - GitHub bridge clone/temp paths
  - publish staging paths
  - updater temp paths
- Any profile-owned temp files should be under `<userData>/tmp` or OS temp with a profile-specific prefix.
- Keep shared binary/download caches only if they are read-only or content-addressed and not profile identity/state.

Acceptance criteria:

- Logs and crash reports are profile-local.
- Running two profiles does not mix GitHub bridge temp work.
- Only one running profile process owns updater checks/downloads at a time.
- Update relaunch returns to the same active profile or follows an explicitly documented fallback.
- Packaged builds do not attempt to write crash reports inside `app.asar` or install directories.

### WP8: Profile Management UX and Launching

Purpose: make the feature usable without requiring terminal flags.

Tasks:

- Add a profile picker for startup when requested by setting or when no default is selected.
- Add UI to:
  - create profile
  - rename profile
  - delete profile with confirmation
  - open another profile
  - show current profile name
- Expose the active profile to the renderer via IPC/preload, for example `profile:get-active` returning `{ id, displayName }`.
- Treat profile ids as immutable internal identifiers and display names as mutable user-facing names.
- Use display names in user-facing copy, menus, deletion prompts, and errors.
- During profile creation, default to independent managed nodes.
- Add advanced node options:
  - independent managed nodes
  - external/shared Bee endpoint
  - external/shared IPFS endpoint and gateway
  - external/shared Radicle endpoint
  - disabled nodes where supported
- Clearly explain external node mode in UI copy:
  - node identity and node storage are shared outside this profile
  - Freedom will not stop external nodes on quit
- Add a menu item:
  - `File > Manage Profiles...`
- On macOS, spawn a separate app instance for another profile:
  - packaged app equivalent of `open -n -a Freedom --args --profile=<id>`
  - development equivalent using the current Electron/npm launch command
- On Windows/Linux, spawn the current executable with `--profile=<id>`.
- If the target profile is already open:
  - show a message
  - later enhancement: focus the existing profile process via per-profile IPC
- For profile deletion:
  - refuse to delete the currently open profile
  - require typing the profile display name
  - warn that deletion removes vault data, browser data, node data, RPC keys, and local app settings
  - warn that Bee postage stamps and other value-bearing local node state may be lost
  - v1 does not attempt to count Bee postage stamps before deletion; typed confirmation plus the value-bearing-data warning is the guardrail

Acceptance criteria:

- A non-technical user can create and open a second profile.
- The current profile is visible somewhere low-noise in the UI.
- Opening another profile creates a new process with that profile's `userData`.
- Deleting a profile refuses to delete the currently open profile.
- Deleting a non-active profile requires typed confirmation and shows value-bearing data warnings.
- External/shared node mode is visible before and after profile creation.

### WP9: Migration Strategy

Purpose: preserve existing users while moving toward profile-aware storage.

Tasks:

- Treat the existing userData directory as the default profile.
- Create `profile.json` for the default profile on first run after upgrade.
- Create `profile-registry.json` if missing.
- Assign default profile managed slot 0 ports in the catalog/profile metadata.
- Do not move existing settings/history/bookmarks for default profile.
- On first profile-aware launch, detect compatible daemons on protocol default ports:
  - Bee `127.0.0.1:1633`
  - IPFS API `127.0.0.1:5001` and gateway `127.0.0.1:8080`
  - Radicle HTTP `127.0.0.1:8780`
- If a compatible default-port daemon exists, show a one-shot prompt for that profile/protocol:
  - "Use existing external node at this endpoint"
  - "Use a Freedom-managed node on a profile-specific port"
- Store the choice as that protocol's mode in profile metadata.
- If the prompt cannot be shown before node startup, mark the protocol as pending external-candidate choice and delay auto-start for that protocol until the choice is resolved.
- For dev-mode repo-root directories:
  - do not migrate them
  - do not automatically merge them into named profiles
  - treat old `bee-data`, `ipfs-data`, `radicle-data`, and `identity-data` as legacy/manual data
  - ignore them unless an explicit advanced override points at them
  - on dev first launch, log a visible one-time warning if any legacy repo-root data dirs are present
- For legacy quick-unlock:
  - only upgrade credentials found in the active profile identity directory
  - avoid importing shared repo-root credentials
- For node configs:
  - preserve explicit external-node choices where users relied on default-port reuse
  - set Freedom-managed default profile metadata to managed slot 0 ports
  - rely on the managers' existing config writers to rewrite Bee/Kubo/Radicle daemon config files on next managed start
  - assign new named-profile ports at creation
- Preserve existing managed node data across port migration. Bee identity, swarm key, postage stamps, stored chunks, IPFS peer identity, pinned data, and Radicle state should survive; only listen/API addresses change.
- If a profile's managed slot port is busy during migration/startup, route startup through the managed-mode port-conflict flow.

Acceptance criteria:

- Existing packaged users open the app after upgrade and see their existing data.
- Users who previously relied on system daemons on default ports get a clear one-time path to external mode.
- Named profile creation starts from empty isolated storage.
- Dev `npm start` starts from checkout-scoped dev storage, not repo-root legacy data.
- Dev legacy repo-root data is not deleted and is called out in logs if present.
- Existing managed node identities/data are preserved when profile metadata moves to managed slot ports.
- No migration step deletes old profile or repo-root data.

### WP10: Test and Verification Matrix

Purpose: prove the feature works across the failure modes that triggered the audit.

Unit tests:

- profile id validation and path resolution
- durable profile catalog creation/update/repair
- partial profile creation recovery and unregistered profile directory handling
- slot reuse after profile deletion
- dev checkout-id derivation from repo root, subdirectory launch stability, and full-path `FREEDOM_DEV_HOME` override
- port slot allocation and persistence
- dev managed port range and always-on checkout-offset behavior
- blocked-port reassignment and catalog/profile metadata sync
- profile lock acquire/recover/fail
- app-level updater owner lock behavior
- profile paths with dev, packaged mock, and env overrides
- quick-unlock credential path and metadata binding
- node port allocation persistence
- default-port external candidate detection
- service-registry endpoint getters return unavailable/null before hydration, not ecosystem default ports
- manager behavior by node mode:
  - managed mode reassigns or prompts for busy assigned ports
  - external mode connects only to configured endpoints
  - disabled mode does not probe/start
- identity injection path consistency
- hardcoded endpoint audit helpers or snapshot checks for `1633`/`5001`/`8080`/`8780` in runtime code paths

Integration tests:

- launch profile A and profile B with separate `FREEDOM_TEST_USER_DATA` roots
- launch profile A and profile B with `FREEDOM_PROFILE` against a temp app data root so the catalog/resolver path is exercised
- launch dev profile A and profile B in a checkout-scoped dev namespace
- verify two mocked checkout paths resolve to different dev profile catalogs
- verify `npm start` from a subdirectory resolves to the repo-root checkout id
- verify legacy repo-root dev data triggers a visible ignored-data warning
- verify settings/bookmarks/history isolation
- verify session storage/cookies isolation
- verify quick-unlock mocks cannot cross-unlock another profile
- verify service registry reports profile-specific ports
- verify profile catalog lists both profiles and assigned ports
- verify same-profile second launch fails or redirects cleanly
- verify a compatible daemon on another profile's port is not reused by a managed profile
- verify compatible daemons on protocol default ports produce an external-mode choice, not silent reuse
- verify blocked non-default managed ports trigger atomic port-set reassignment and metadata persistence
- verify only one profile process owns updater checks
- verify renderer/preload waits for service-registry hydration instead of using default-port fallback URLs

Live/manual smoke tests:

- Dev:
  - `npm start`
  - `npm start -- --profile=work`
  - same commands from a second checkout
  - confirm packaged userData and repo-root legacy data are untouched
- macOS packaged:
  - `open -n -a Freedom --args --profile=personal`
  - `open -n -a Freedom --args --profile=work`
- Create identity in profile A and profile B.
- Enable Touch ID in profile A, then profile B, then unlock profile A again.
- Start Bee/IPFS/Radicle in both profiles.
- Confirm ports and data dirs differ.
- Quit profile A and confirm profile B nodes stay alive.
- Configure a profile to use an explicit external node and confirm the UI labels it as external/shared.
- Try launching profile A twice and confirm guard behavior.
- On macOS, verify multiple profile instances can launch and `Info.plist` does not prohibit multiple instances.
- Verify update relaunch preserves the active profile or follows the documented fallback.
- Verify profile deletion requires typed confirmation and shows vault/stamp/data warnings.
- Verify docs and package scripts no longer describe ecosystem default ports as Freedom-managed node endpoints.
- Verify Windows/Linux dev paths with spaces are handled by tests or smoke scripts.
- Verify `Info.plist` does not set `LSMultipleInstancesProhibited`.

Required commands after implementation:

```sh
npm run lint
npm test
```

Run targeted tests for touched modules as they are added, then run full lint and tests before merging.

---

## Implementation Roadmap

### Milestone 1: Safe Profile Foundations

Goal: create profile identities and directories without changing node behavior yet.

1. Add tests and profile bootstrap scaffolding.
2. Add durable profile catalog and profile-local `profile.json`.
3. Add canonical profile resolver and early `userData` setup, including checkout-scoped dev profile roots, `Freedom Dev` app name, and repo-root-based checkout id.
4. Add profile path helpers and move dev defaults under `userData`.
5. Move crash dumps/log/temp paths under the active profile.
6. Add the cross-platform lock dependency or approved fallback for catalog/profile/updater locks.

Deliverable:

- `Freedom --profile=work` starts with isolated app/browser data.
- `npm start -- --profile=work` starts with checkout-scoped isolated dev app/browser data.
- Default profile keeps existing data.
- No node-manager behavior changes are required yet.

### Milestone 2: Identity and Unlock Isolation

Goal: make profile identity and quick unlock safe before users create parallel profiles.

1. Fix quick unlock isolation and vault binding.
2. Fix identity injection path duplication.
3. Add profile-local vault ids and quick-unlock credential migration.
4. Clear or refresh quick unlock on vault password change/delete.

Deliverable:

- Touch ID enabled in profile B cannot break profile A.
- Identity setup writes Bee/IPFS/Radicle keys to the active profile's data dirs.

### Milestone 3: Same-Profile Safety

Goal: allow different profiles while protecting one profile from concurrent access.

1. Add per-profile lock.
2. Add stale-lock recovery.
3. Wire v1 duplicate-profile launch UX with `dialog.showErrorBox()` and quit.
4. Add app-level updater owner lock and profile-preserving update relaunch behavior.

Deliverable:

- Profile A and profile B can run in parallel.
- A second launch of profile A is blocked or redirected safely.

### Milestone 4: Independent Managed Nodes

Goal: make managed nodes truly profile-local.

1. Allocate non-default managed profile ports at profile creation.
2. Allocate dev managed profiles from the dev port range with always-on checkout-derived offsets.
3. Pass resolved ports into service registry and node managers.
4. Remove ecosystem-default-port fallbacks from service-registry getters, preload, renderer code, and runtime helpers.
5. Write daemon configs from profile runtime config.
6. Disable silent compatible-daemon reuse in `managed` mode.
7. Add busy-port reassignment flow with catalog/profile metadata persistence.
8. Add one-shot default-port external candidate detection for users with system daemons.

Deliverable:

- Two managed profiles run Bee/IPFS/Radicle on distinct ports and data dirs.
- Quitting one profile does not stop another profile's nodes.

### Milestone 5: Explicit External Node Mode

Goal: preserve power-user reuse without ambiguous auto-reuse.

1. Add per-profile, per-protocol external endpoint settings.
2. Update managers to support `managed`, `external`, and `disabled` modes.
3. Label external/shared status in node UI.
4. Ensure shutdown only stops managed child processes started by this profile.

Deliverable:

- A user can intentionally share an external node.
- The app never mistakes another Freedom profile's daemon for an external node in managed mode.

### Milestone 6: Product UX and End-to-End Verification

Goal: make the feature discoverable and prove it works.

1. Add profile picker/profile management UI.
2. Add profile launching from the profile manager.
3. Add active-profile IPC/preload exposure.
4. Add hardened profile deletion flow.
5. Add migration coverage.
6. Add E2E and manual packaged two-profile smoke tests.
7. Document macOS multi-instance and external deep-link behavior.
8. Update README/dev scripts/docs so ecosystem default ports are described as external/system defaults, not Freedom-managed endpoints.

Deliverable:

- Users can create and launch profiles from the app.
- The full multi-profile test matrix passes.

This order fixes the user-visible Touch ID profile collision early while building toward full parallel managed-node support.

---

## Open Design Questions

1. Should the default profile be shown as "Default" forever, or should users be able to rename it?
2. Should named profile directories use opaque ids (`p_abc123`) or sanitized names (`work`)? Recommendation: sanitized stable ids first; add opaque ids later only if name collisions become painful.
3. Should quick setup remain Touch-ID-only when random password is generated? Recommendation: keep behavior, but make quick-unlock binding strict and failure messages clear.
4. Should port reassignment be automatic on conflict or user-confirmed? Recommendation: auto-reassign before a profile's first successful run; user-confirm after a profile has already run successfully.
5. Should external OS deep links always route to the default profile in v1, or should the last-focused process win? Recommendation: default profile wins for deterministic behavior; if the default profile is already running, deliver/focus that process.

---

## Risks

- Port allocation can still race if two new profiles launch at the same time. Persist ports at profile creation and verify at startup.
- A non-default managed port can still be blocked by unrelated software on a user's machine. Validate ports at startup and persist any reassignment before starting nodes.
- Dev checkouts can collide if the checkout-id hash or port offset is poorly chosen. Include the checkout hash in the dev namespace and still validate/reassign ports at startup.
- Dev checkout identity must be anchored to the repo root containing `package.json`, not `process.cwd()`, or subdirectory launches will create accidental extra dev homes.
- Any leftover hardcoded fallback to `1633`, `5001`, `8080`, or `8780` can silently talk to a system daemon after the slot-0 pivot. Audit runtime code and scripts before enabling managed non-default ports.
- Stale lock recovery can be dangerous if implemented incorrectly. Prefer `proper-lockfile` or equivalent cross-platform locking over a homegrown lock.
- Daemon "reuse" is convenient for power users. Preserve it, but only behind an explicit setting.
- The durable profile catalog can drift from profile-local metadata. Prefer profile-local metadata and repair the catalog.
- Quick-unlock migration must avoid blessing the old shared dev credential for named profiles.
- macOS `safeStorage`/Keychain access is app-bundle scoped, not profile scoped. Quick-unlock profile/vault metadata binding is the protection boundary.
- Profile deletion is destructive and can remove value-bearing local state such as Bee postage stamps. Require typed confirmation and strong warnings; v1 deliberately does not start or probe inactive profile nodes to count stamps.
- App updates are app-scoped, not profile-scoped. Exactly one running profile process should own updater checks/downloads.
- The updater owner lock must live in the app data root. A profile-local updater lock would be vulnerable to profile deletion and would not correctly represent app-wide ownership.
- Update relaunch can silently fall back to the default profile if launch args are not preserved. Treat that as a blocker for automatic install flows.
- macOS LaunchServices may route external protocol URLs to one app instance. Document v1 behavior and avoid ambiguous profile routing.
- The app data root doubles as the default profile directory for backward compatibility. This is intentional, but the catalog/profile-local split must be documented clearly for maintainers.
- Lock files inside a profile directory can be orphaned if profile deletion aborts halfway. Profile deletion should use the catalog write lock and refuse deletion of live profiles.
- Moving dev defaults out of repo-root data can surprise developers with existing repo-root test data. Treat repo-root dev data as legacy/manual and support explicit advanced overrides.
- Dev legacy data should be ignored, not migrated or deleted, but first-launch logging should make the behavior visible.

---

## Definition of Done

Multi-profile support is complete when:

- profiles can be created and launched from the UI
- profile A and profile B can run at the same time
- profile A and profile B have separate browser storage, app state, identity vaults, quick-unlock credentials, node data dirs, logs, crash reports, and non-default managed daemon ports
- Touch ID enabled in one profile does not affect another profile
- a second launch of the same profile is prevented or redirected safely
- external daemon reuse is explicit, visible, and per profile/protocol
- dev `npm start` uses checkout-scoped dev profiles and does not touch packaged userData or repo-root legacy data by default
- dev checkout ids are stable across subdirectory launches and dev managed ports include a checkout-derived offset
- exactly one running profile process owns updater checks/downloads
- profile deletion is guarded by typed confirmation and value-bearing data warnings
- default profile users keep their existing data
- lint, unit tests, integration tests, and manual two-profile smoke tests pass
