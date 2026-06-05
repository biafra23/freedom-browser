# Dropping `ant` in for `bee` in Freedom

Plan for replacing the bundled Swarm **Bee** node with **Ant** (`antd`, a
lightweight Rust Swarm light node that speaks the bee HTTP API).

**What "drop-in" means here:** identical functionality and the same HTTP
API calls (so `@ethersphere/bee-js@^12` and the wire protocol are
untouched), **but the `Ant` name is surfaced** across Freedom's UI and
tooling. The user-facing headline is **"bee replaced by ant"** — this is
a deliberate rebrand, not a hidden swap. So we keep the bee-compatible
*protocol* and rename everything *presentational*.

The key idea is three concentric rings (Section 3): an immutable
protocol core that stays bee-shaped, a presentation ring that becomes
"Ant" (this delivers the headline), and an internal-identifier ring we
rename for consistency with care around migrations.

> Scope: this document covers only the **Freedom-side** work (the rings
> model, the rebrand, the fetch tooling, and migrations). All `antd`-side
> changes — bee-compatible HTTP API, CLI shape, binary publishing, runtime
> postage, chequebook bootstrap, visible-peers reporting — are tracked solely
> upstream in the Ant project, the single source of truth for Ant.

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

This is the contract a drop-in must satisfy. Whether/how `antd` meets each
row — HTTP API surface, `/health` shape, CORS, YAML keys, `keys/swarm.key`
decode, graceful `SIGTERM`, on-chain publish flow — is tracked upstream in the
Ant project.

---

## 2. Ant-side prerequisites (tracked upstream in the Ant project)

The changes that make `antd` a clean drop-in target — CLI compatibility
(`start`/`init`/bare-flag), per-platform binary publishing with `SHA256SUMS`,
the dev/fallback keystore-writing `init`, runtime postage management,
chequebook auto-bootstrap, and visible-peers reporting — are **not** owned by
this repo. They are tracked, with status, upstream in the Ant project.

One item needs a Freedom-side check rather than an Ant change: **ENS.**
Confirm Freedom resolves ENS itself (`src/main/ens-resolver.js`,
`ens-prefetch.js`) and never relies on the node's `resolver-options`. Verify
before GA.

---

## 3. Track C — the rebrand: rename rings ("bee replaced by ant")

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

## 4. Validation / acceptance checklist

These validate the **swap from Freedom's side**; `antd`-side acceptance
(CLI gates, identity-derivation correctness) lives upstream in the Ant project.

- **Identity parity:** overlay + Ethereum address derived from an
  injected `swarm.key` match what bee derives for the same key (compare
  `GET /addresses`).
- **bee-js v12 flows** exercised by Freedom go green against Ant:
  upload (`POST /bzz` with stamp), download (`GET /bzz`), feeds, stamps
  list/get, `/status`, `/chainstate`, `/wallet`, `/chequebook/*`.
- Run Freedom’s suites with Ant swapped in: `npm run test:e2e`,
  `test:e2e:live`, `test:e2e:onboarding`.
- ENS resolution: confirm `bzz://<name>.eth` works via Freedom’s own
  resolver (the ENS check in §2).

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

## 5. Rollout

- **Phase 0 — local smoke.** Build `antd --release` for the host, copy to
  `bee-bin/<host>/bee`, run Freedom dev against a throwaway
  `FREEDOM_BEE_DATA`, smoke bee-js upload/download.
- **Ant-side prerequisites.** CLI compatibility and published binaries +
  checksums — tracked upstream in the Ant project, not here.
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

## 6. Risks & notes

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
