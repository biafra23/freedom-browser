# Dropping `ant` in for `bee` in Freedom

Plan for replacing the bundled Swarm **Bee** node with **Ant** (`antd`, a
lightweight Rust Swarm light node that speaks the bee HTTP API).

**What "drop-in" means here:** identical functionality and the same HTTP
API calls (so `@ethersphere/bee-js@^12` and the wire protocol are
untouched), **but the `Ant` name is surfaced** across Freedom's UI and
tooling. The user-facing headline is **"bee replaced by ant"** — this is
a deliberate rebrand, not a hidden swap. So we keep the bee-compatible
*protocol* and rename everything *presentational*.

The key idea is three concentric rings (Section 5): an immutable
protocol core that stays bee-shaped, a presentation ring that becomes
"Ant" (this delivers the headline), and an internal-identifier ring we
rename for consistency with care around migrations.

> Status of the Ant side: the bee-shaped HTTP API, CORS (`null` origin),
> bee YAML config parsing, Web3-v3 `keys/swarm.key` decryption, graceful
> SIGTERM, and the on-chain publish flow (buy/topup/dilute stamps,
> wallet/chequebook, `/status`, `/chainstate`) are implemented and the
> chain write paths have been validated live on Gnosis mainnet. The one
> remaining hard blocker is CLI-shape compatibility (`start` / `init`
> subcommands) — see Track A.

---

## 1. How Freedom uses the Bee binary today (facts from the code)

All of this is what a drop-in must satisfy. References are to this repo.

| Concern | Where | Behaviour |
|---|---|---|
| Binary path (dev) | `src/main/bee-manager.js` `getBeeBinaryPath()` | `bee-bin/<os>-<arch>/bee` (`.exe` on win). `<os>` ∈ `mac/linux/win`, `<arch>` ∈ `arm64/x64`. |
| Binary path (packaged) | same | `process.resourcesPath/bee-bin/bee[.exe]`. |
| Download | `scripts/fetch-bee.js` | Pulls `ethersphere/bee` **latest** GitHub release, picks per-platform asset by keyword (`darwin/amd64`, `linux/arm64`, `windows/amd64`, …), extracts a binary named `bee` into `bee-bin/<os>-<arch>/`, `chmod 755`. |
| Build gate | `scripts/check-binaries.js` | `dist`/`build` fails unless `bee-bin/<os>-<arch>/bee[.exe]` exists. |
| Packaging | `package.json` → `build.extraResources` | Copies `bee-bin/${os}-${arch}/` → `bee-bin`, and `config/bee.yaml` → `bee.yaml`. |
| Run | `bee-manager.js` `startBee()` | `spawn(binPath, ['start', '--config=<configPath>'])`. |
| Key init | `bee-manager.js` `ensureConfig()`, `scripts/init-bee.js` | `execSync('"<bin>" init --config="<config>"')` when `keys/` is absent **and** identity isn't injected. |
| Runtime config | `bee-manager.js` `buildBeeConfigContent()` / `src/main/identity/injection.js` `createBeeConfig()` | YAML with: `api-addr`, `swap-enable`, `mainnet`, `full-node`, `blockchain-rpc-endpoint`, `cors-allowed-origins` (`"null"` for the managed node, `"*"` for the injection helper), `skip-postage-snapshot`, `resolver-options`, `storage-incentives-enable`, `data-dir`, `password`. |
| Health / readiness | `bee-manager.js` `probeBeeApi()` / `checkHealth()` | `GET /health` must return `200` + JSON (`version` is read). Startup poll: up to **60×1s**. Liveness poll every 5 s. |
| External-daemon reuse | `detectExistingDaemon()` | If something already answers `/health` on `1633`, Freedom **reuses** it and never spawns its own. |
| Identity injection | `src/main/identity/injection.js` + `formats.js` | `keys/swarm.key` = `ethers` `Wallet.encrypt()` → standard **v3 keystore** (scrypt, AES‑128‑CTR, lowercase `crypto`). Password is written into the config. `setUseInjectedIdentity(true)` makes bee‑manager skip `init`. |
| Shutdown | `stopBee()` | `SIGTERM`, then `SIGKILL` after **5 s**. |

### What Ant already satisfies
- bee HTTP API surface used by `bee-js` (upload/download/feeds/stamps/status…).
- `GET /health` shape (`{status, version, apiVersion}`), `200`.
- `cors-allowed-origins: "null"` and `"*"`.
- bee YAML keys above (unknown keys accepted + ignored).
- `keys/swarm.key` v3 keystore decode (ethers output: lowercase `crypto`, scrypt, AES‑128‑CTR) using the config `password`.
- Graceful `SIGTERM` well under the 5 s force-kill window.
- On-chain publish flow (validated live on Gnosis).

---

## 2. Gaps that block a clean swap (fix on the Ant side)

1. **CLI subcommands — hard blocker.** `antd` is flag-only; it rejects
   `start` and `init` (`error: unexpected argument 'start' found`).
   Freedom spawns `bee start --config=…` and `bee init --config=…`. Ant
   must accept both. See Track A.
2. **`resolver-options` (ENS).** bee can resolve ENS names for `bzz://`.
   Confirm Freedom resolves ENS itself (`src/main/ens-resolver.js`,
   `ens-prefetch.js`) and doesn't rely on the node's `resolver-options`;
   if it does, Ant needs an equivalent or Freedom must always resolve
   client-side. **Action: verify before GA.**
3. **Release build required.** The injected keystore uses scrypt
   `n=131072`; decryption is fast in a `--release` build but multiple
   seconds in `debug`. Ship release binaries only.
4. **`init` must produce the exact keystore Freedom expects when *not*
   injecting** (dev/fallback path): write `keys/swarm.key` as a v3
   keystore encrypted with the config `password`, then exit `0`. When a
   key is already injected, `init` is a successful no-op.

---

## 3. Track A — make `antd` CLI-compatible

Add a `clap` subcommand layer while keeping today's bare-flag invocation
working (back-compat for our own tooling/tests):

- `antd start [--config <f>] [flags…]` → run the node (current default).
- `antd init  [--config <f>] [--password / --password-file]` →
  - if `keys/swarm.key` exists (injected): log + exit `0`;
  - else generate a secp256k1 key, write it as a v3 keystore at
    `<data-dir>/keys/swarm.key` encrypted with the resolved password,
    and exit `0`.
- Bare `antd [flags…]` (no subcommand) → behaves like `start` (so our
  systemd units and the live-test harness are unaffected).

Acceptance: `antd start --config X` boots and serves `/health`;
`antd init --config X` writes a keystore (or no-ops) and exits `0`;
`antd --version` prints the deployed version.

---

## 4. Track B — build & publish Ant binaries ("upload binaries somewhere")

Yes — publish prebuilt, release-mode `antd` binaries per platform so
Freedom can fetch them exactly like it fetches bee.

**Targets** (mirror `fetch-bee.js`):

| os-arch | rust target | how |
|---|---|---|
| `linux-x64` | `x86_64-unknown-linux-gnu` (or `-musl`) | native / `cargo-zigbuild` |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | `cross` / zigbuild |
| `mac-x64` | `x86_64-apple-darwin` | macOS runner |
| `mac-arm64` | `aarch64-apple-darwin` | macOS runner |
| `win-x64` | `x86_64-pc-windows-gnu`/`-msvc` | windows runner / `cross` |
| `win-arm64` | (copy x64, emulation) | mirror bee's fallback |

**Packaging & naming.** Produce one archive per target whose name
contains os+arch keywords a fetch script can match (e.g.
`antd-<version>-<os>-<arch>.tar.gz` / `.zip`), each containing a single
binary. Because we are **surfacing the Ant name**, ship the binary as
`antd`/`antd.exe` (not `bee`) and have Freedom's tooling install it into
an `ant-bin/<os>-<arch>/` tree. (See Ring 2 in Section 5 — the binary
name and its directory are part of the rename.)

**Where to upload.** Simplest is **GitHub Releases on the `ant` repo**
(the existing fetch script already speaks the GitHub releases API):
tag = the deployed version, attach the 5 archives + a `SHA256SUMS` file.
Alternatives: any HTTPS/CDN, or Swarm itself (bootstrap chicken-and-egg
— avoid for the bundled fetch). **Always publish checksums** and verify
them on download.

**CI.** Add a release workflow (build matrix → archive → checksum →
create GitHub Release). macOS targets need a macOS runner; Linux/Windows
can cross-compile.

---

## 5. Track C — the rebrand: rename rings ("bee replaced by ant")

Surfacing the Ant name touches ~1,700 `bee` references across the repo,
but they are **not equal**. Sort every occurrence into one of three
rings and treat each differently.

### Ring 0 — Protocol core (NEVER rename; it's the wire contract)
Renaming these breaks API compatibility with the node and `bee-js`:
- The HTTP endpoints and request/response shapes (`/bzz`, `/stamps`,
  `/status`, `/chainstate`, `/wallet`, `/chequebook/*`, `/health`, …).
- The `@ethersphere/bee-js@^12` dependency (it's the client library;
  Ant answers its calls). Internal *wrappers* like `fetchBeeJson()` may
  be renamed (Ring 2) but the package stays.
- The bee **YAML config keys** (`api-addr`, `cors-allowed-origins`,
  `blockchain-rpc-endpoint`, `swap-enable`, `mainnet`, `full-node`,
  `data-dir`, `password`, …) — Ant's parser expects these. The config
  *file name* can change (Ring 2); the *keys* cannot.
- On-disk identity contract: `keys/swarm.key` (Web3 v3 keystore) and the
  Swarm data-dir layout Ant reads. Default API port `1633`.
- The word "Swarm" where it names the **network/protocol** (that's
  accurate regardless of which node implementation runs).

### Ring 1 — Presentation (RENAME to "Ant" — this *is* the headline)
Everything a human reads. This is the deliverable; do it first.
- Renderer UI strings, e.g. `src/renderer/index.html` ("Bee wallet
  xBZZ", "…once Bee has xDAI…", stamp-manager copy),
  `src/renderer/lib/wallet/*` ("Bee wallet address", "Bee wallet"
  badge), `swarm-readiness.js` ("Bee is finishing light-node setup"),
  `bee-ui.js` toasts/debug ("Failed to toggle Bee", "Bee Status
  Update"), `navigation.js` ("Bee unreachable").
- Menu/labels and status pills that show the node name.
- Settings page copy in `src/renderer/pages/settings.html`. (Note: some
  copy already says "Swarm node" — keep that; only "Bee" → "Ant".)
- Docs/README sections describing the bundled node; `CHANGELOG.md`
  headline entry: **"Bee replaced by Ant."**
- The `assets/` node icon, if it's bee-branded.

Decision rule for Ring 1: if a string means *"the node software"*, it
becomes **Ant**; if it means *"the Swarm network"*, leave it **Swarm**.

### Ring 2 — Internal identifiers (rename for consistency, with care)
Not user-visible, but renaming makes the codebase honest. Each carries a
migration or coordinated-change cost, so these can be staged after the
headline lands:
- **Binary + bundled dir:** `bee-bin/<os>-<arch>/bee` → `ant-bin/<os>-<arch>/antd`. Touches `bee-manager.js` `getBeeBinaryPath()`, `package.json` `build.extraResources` (`bee-bin/${os}-${arch}/` → `ant-bin/...`), and `scripts/check-binaries.js`. Build-time only — **no user migration** needed.
- **User data dir:** `userData/bee-data` → `userData/ant-data`
  (`bee-manager.js` `getBeeDataPath()`). **Start fresh — do NOT copy or
  rename the old `bee-data` cache.** This is safe because the node
  identity is **not** stored in that dir as the source of truth: it is
  deterministically derived from the user's vault mnemonic at BIP-44
  `m/44'/60'/0'/0/1` (`src/main/identity/derivation.js` `BEE_WALLET`)
  and re-injected as `keys/swarm.key` on every start
  (`identity-manager.js` → `injection.injectBeeKey`). So a brand-new
  `ant-data` re-derives the **same** wallet/overlay; only the disposable
  cache (chunk store, statestore, peerstore) is lost and re-syncs. No
  migration shim needed. The old `bee-data` can simply be left in place
  (or cleaned up later); it is **not** referenced.
  - ⚠️ **Light/SWAP mode only:** the chequebook association lives in the
    statestore. With a fresh dir, recover the chequebook from chain for
    the (re-derived) bee wallet rather than deploying a new one — Ant
    supports a `--chequebook` hint and a factory check; wire Freedom to
    pass the known chequebook (or let Ant rediscover it) so a fresh dir
    doesn't trigger a new on-chain deployment. (Default ultra-light mode
    has `swap-enable: false` and no chequebook, so this doesn't apply.)
- **Config file name:** `config/bee.yaml` → `config/ant.yaml`
  (extraResources `to: bee.yaml` → `ant.yaml`; runtime writers in
  `bee-manager.js`/`identity/injection.js`). Keys stay (Ring 0).
- **Settings keys:** `beeNodeMode`, `startBeeAtLaunch`
  (`settings-store.js` defaults; `settings.html` field ids). ⚠️ Migrate
  old keys → new on load to preserve user preferences.
- **Service-registry key:** `registry.bee` / `DEFAULTS.bee` /
  `MODE` usage — the `'bee'` service id flows through main *and*
  renderer; renaming to `'ant'` is a coordinated multi-file change.
- **IPC channels:** `BEE_START='bee:start'` … in
  `src/shared/ipc-channels.js` plus `swarm:ensure-bee-wallet-identity`.
  Values are arbitrary; rename both ends together.
- **Module/file names:** `bee-manager.js`, `bee-ui.js`, and their
  `.test.js` siblings → `ant-*`. Pure churn; do last. Per `AGENTS.md`,
  adding/moving files in `src/main/`–`src/renderer/` requires reading
  `docs/agent-playbooks/architecture-boundaries.md` first.

### Fetch tooling (spans Ring 1 visible + Ring 2)
- Add `scripts/fetch-ant.js` (fork of `fetch-bee.js`): resolve the Ant
  release, download per-platform asset, **verify `SHA256SUMS`**, install
  as `ant-bin/<os>-<arch>/antd[.exe]` (`chmod 755`), copy `win-x64` →
  `win-arm64`.
- npm scripts: `bee:download/init/start/stop/status/reset` →
  `ant:download/...`. Update `dist:*` and CI to call them.
- `scripts/check-binaries.js`: check `ant-bin/.../antd` instead of
  `bee-bin/.../bee`.

> Per repo `AGENTS.md`: don't add/upgrade deps without approval; run
> `npm run lint` + `npm test` after edits (Ring 1/2 will touch many
> `.test.js` expectations — budget for snapshot/string updates); read
> `docs/agent-playbooks/architecture-boundaries.md` before any
> `src/main/` / `src/renderer/` file moves, and
> `docs/agent-playbooks/changelog-process.md` for the headline entry.

---

## 6. Validation / acceptance checklist

- `bee init --config <f>`: writes `keys/swarm.key` (or no-ops when
  injected) and exits `0`.
- `bee start --config <f>`: `/health` is `200` within Freedom's 60 s
  poll; `SIGTERM` exits in < 5 s.
- **Identity parity:** overlay + Ethereum address derived from an
  injected `swarm.key` match what bee derives for the same key (compare
  `GET /addresses`). (Ant already derives eth + overlay from the
  keystore; confirm overlay nonce convention matches bee’s default.)
- **bee-js v12 flows** exercised by Freedom go green against Ant:
  upload (`POST /bzz` with stamp), download (`GET /bzz`), feeds, stamps
  list/get, `/status`, `/chainstate`, `/wallet`, `/chequebook/*`.
- Run Freedom’s suites with Ant swapped in: `npm run test:e2e`,
  `test:e2e:live`, `test:e2e:onboarding`.
- ENS resolution: confirm `bzz://<name>.eth` works via Freedom’s own
  resolver (gap #2).

**Rebrand acceptance (the headline):**
- No user-visible string says "Bee" where it means the node — UI, menus,
  status pills, settings, toasts all read **"Ant"**. "Swarm" remains
  where it means the network. (Spot-check: `grep -rnE "Bee" src/renderer`
  returns only Ring-0/protocol or comments.)
- `CHANGELOG.md` carries the "Bee replaced by Ant" entry.
- Tooling renamed: `npm run ant:download` fetches `antd` into
  `ant-bin/`; `check-binaries.js` and packaging reference `ant-bin`.
- **Settings migration:** an existing user’s `beeNodeMode` /
  `startBeeAtLaunch` carry over to the renamed keys (no reset to
  defaults).
- **Fresh data dir (no cache copy):** on upgrade, Ant runs against a new
  empty `ant-data`; the old `bee-data` cache is **not** copied or
  renamed. The bee **wallet/overlay is unchanged** because it is
  re-derived from the vault and re-injected — verify `GET /addresses`
  reports the same overlay/eth as before the upgrade. The chunk
  store/peerstore start empty and re-sync (expect a brief warm-up).
  (Light mode: confirm the chequebook is rediscovered, not redeployed.)

---

## 7. Rollout

- **Phase 0 — local smoke.** Build `antd --release` for the host, copy to
  `bee-bin/<host>/bee`, run Freedom dev against a throwaway
  `FREEDOM_BEE_DATA`, smoke bee-js upload/download. (No CLI changes
  needed if you temporarily wrap `start`.)
- **Phase 1 — CLI compat.** Implement `start`/`init` (Track A); re-smoke
  with the unmodified `bee-manager` spawn path.
- **Phase 2 — publish.** CI cross-build matrix + GitHub Release with
  checksums (Track B).
- **Phase 3 — wire Freedom + Ring 1 rebrand.** Add `fetch-ant.js`,
  switch the download/npm scripts (Ring 2 tooling), and do the **Ring 1
  presentation rename** so the UI reads "Ant". `dist` a Freedom build,
  run the e2e suites. This is the phase that ships the headline.
- **Phase 4 — Ring 2 cleanup.** Rename internal identifiers (binary/dir,
  config filename, settings keys + migration, service-registry key, IPC
  channels, module files) with the data/settings migration shims. Pure
  consistency; can trail the headline.
- **Phase 5 — ship.** Behind a channel/flag; keep the bee fetch path as a
  fallback until Ant has soaked. Land the `CHANGELOG.md` headline.

---

## 8. Risks & notes

- **macOS signing/notarization.** The node binary ships as an
  `extraResource`. Confirm how the bee binary is currently handled by
  `scripts/macos-notary.js` / `dist:mac:*`; the Ant binary likely needs
  the same signing / hardened-runtime treatment to launch on sealed
  macOS builds.
- **Windows arm64.** No native build → copy x64 (emulation), exactly
  like bee.
- **External-daemon reuse.** If a real bee is already on `1633`, Freedom
  reuses it and won’t start Ant — fine, but note it for testing (kill
  stray bee first, or use a throwaway data dir + the fallback-port path).
- **Version string.** Keep `antd --version` and `/health.version`
  meaningful so the journal and Freedom’s reuse logic can correlate a
  build.
- **Keep bee as fallback** during rollout so a regression doesn’t brick
  the publish flow.
- **Test churn from the rebrand.** ~1,700 `bee` references; many live in
  `.test.js` expectations and renderer snapshots. Ring 1/2 renames will
  break tests that assert on the literal "Bee" — budget time to update
  them, and don't let a string rename silently change behavior
  (`AGENTS.md` rule 7).
- **Migration correctness.** With the fresh-`ant-data` decision, the
  data dir needs **no** migration (identity comes from the vault, cache
  is disposable). The remaining stateful rename is **settings keys**
  (`beeNodeMode` / `startBeeAtLaunch`) — migrate those old→new on load,
  and test upgrade-in-place, not just fresh installs. Light/SWAP mode is
  the one caveat: ensure the chequebook is rediscovered so a fresh dir
  doesn't redeploy one.
- **Don't over-rename Ring 0.** A well-meaning find-and-replace of "bee"
  to "ant" that hits `bee-js`, the config keys, or `swarm.key` will
  break compatibility. The rings exist precisely to prevent this.
