# Bee → Ant Transition — Implementation Plan

Actionable, sequenced execution plan for the swap described in
[`ant-dropin-plan.md`](./ant-dropin-plan.md). That document is the *design*
(the why, the three-ring model, the risks). This document is the *how*: ordered
phases, per-file task lists, and the gate that must be green before moving on.

**Branch:** `feat/bee-to-ant-transition`

**Ant release source:** [`solardev-xyz/ant`](https://github.com/solardev-xyz/ant)
— binaries land at GitHub Releases, first tag
[`v0.5.7`](https://github.com/solardev-xyz/ant/releases/tag/v0.5.7)
(available shortly). The fetch tooling (Phase 3A) targets this repo's releases
API: `api.github.com/repos/solardev-xyz/ant/releases/latest`.

**Guiding constraint (from the rings):** never touch Ring 0 (wire protocol,
`@ethersphere/bee-js`, bee YAML *keys*, `keys/swarm.key`, port `1633`). Rename
Ring 1 (everything a human reads → "Ant") and Ring 2 (internal identifiers,
with migrations). See design doc §3.

**Per-`AGENTS.md`, every code-touching task ends with:** `npm run lint` clean,
and `npm test` for any file with a `.test.js` sibling. File moves under
`src/main/` or `src/renderer/` require reading
`docs/agent-playbooks/architecture-boundaries.md` first; the changelog headline
follows `docs/agent-playbooks/changelog-process.md`.

---

## Phase ordering at a glance

| Phase | Goal | Ships? | Depends on |
|---|---|---|---|
| 0 | Local smoke: prove Ant serves bee-js against Freedom dev | no | Ant release binary |
| 3 | Wire Freedom fetch/tooling + **Ring 1 rebrand** + headless e2e CI | **yes** | Ant binaries published |
| 4 | Ring 2 cleanup: rename internal identifiers + migrations | no (consistency) | Phase 3 |
| 5 | Ship behind a flag, keep bee fallback, land changelog | **yes** | Phase 3/4 |

Phases 0, 3, 4, 5 are **this repo**. The Ant-side prerequisites this plan
depends on (CLI compatibility, binary publishing, runtime postage, chequebook
bootstrap, visible-peers reporting) are tracked upstream in the Ant project —
the single source of truth for `antd` changes.

---

## Phase 0 — Local smoke (this repo, no code changes)

Prove an Ant `--release` binary satisfies Freedom's spawn + health + bee-js
paths *before* investing in tooling/rebrand.

1. Build `antd --release` for the host arch, or grab the host-matching archive
   from [`solardev-xyz/ant` `v0.5.7`](https://github.com/solardev-xyz/ant/releases/tag/v0.5.7)
   once published.
2. Stage it where the unmodified manager looks: copy to
   `bee-bin/<host-os>-<arch>/bee` (e.g. `bee-bin/linux-x64/bee`), `chmod 755`.
   - `getBeeBinaryPath()` resolves `bee-bin/<os>-<arch>/bee` in dev
     (`src/main/bee-manager.js:54`).
3. Run against a throwaway data dir: `FREEDOM_BEE_DATA=/tmp/ant-smoke` (honored
   at `bee-manager.js:84`) so the dev `bee-data/` is untouched.
4. Smoke bee-js: upload (`POST /bzz` w/ stamp), download (`GET /bzz`), `/health`,
   `/addresses`. Confirm `/health` returns `200`+JSON within the 60×1s poll
   (`bee-manager.js:511`) and `SIGTERM` exits < 5s (`bee-manager.js:611`).

**Gate:** Freedom dev runs an Ant node, upload/download round-trips, health +
shutdown timings fit the existing windows.

---

## Ant-side prerequisites *(tracked upstream in the Ant project)*

The drop-in depends on changes inside the `antd` codebase — CLI compatibility
(`start`/`init`), per-platform binary publishing with `SHA256SUMS`, runtime
postage-batch management, chequebook auto-bootstrap, and visible-peers
reporting. These are **not** tracked here; they live in the Ant project's own
plan. This plan only assumes
the host-matching `antd` archives are downloadable from `solardev-xyz/ant`
releases (with `SHA256SUMS`) before Phase 3 wires the fetch tooling.

---

## Phase 3 — Wire Freedom + Ring 1 rebrand (THE HEADLINE — this repo, ships)

This is the deliverable. Three parallel workstreams: **3A tooling** (fetch/build
wiring), **3B presentation rename**, and **3C headless e2e in CI**. Do 3A/3B
together so a `dist` build both pulls `antd` and reads "Ant"; 3C locks in that it
keeps working on every PR.

### 3A — Fetch & build tooling (Ring 1-visible + Ring 2 tooling)

1. **`scripts/fetch-ant.js`** (fork of `scripts/fetch-bee.js`): the upstream
   asset naming (defined upstream in the Ant project) mirrors bee, so this is a
   minimal fork:
   - Point release API at `solardev-xyz/ant` — replace `ethersphere/bee` at
     `fetch-bee.js:23` with `solardev-xyz/ant` (use `…/releases/latest`, or pin
     `…/releases/tags/v0.5.7` until newer tags exist).
   - **Keep the per-target `keywords` arrays unchanged** (`fetch-bee.js:128-135`)
     — Ant's assets use the same `darwin/amd64`, `linux/arm64`, `windows/amd64`
     scheme, so `every(k => name.includes(k))` matches
     `antd-v0.5.7-<asset>.{tar.gz,zip}` directly. (Drop the `.rpm`/`.deb`
     exclusions — Ant only ships tar.gz/zip.)
   - Binary name `bee`→`antd`: `binName` (`fetch-bee.js:155`) and the
     `findBee`/fallback search (`fetch-bee.js:177-188`) look for `antd`/`antd.exe`.
     Archives hold the binary at the root, so the primary extract path hits.
   - **Verify `SHA256SUMS`** after download (new vs. bee script): fetch the
     release's `SHA256SUMS` asset, look up each archive by filename, compare
     before extract.
   - Install as `ant-bin/<os>-<arch>/antd[.exe]`, `chmod 755` (output dir
     `OUTPUT_DIR` `bee-bin`→`ant-bin` at `fetch-bee.js:6`).
   - Copy `win-x64` → `win-arm64` (`fetch-bee.js:203-215`) — Ant publishes no
     `win-arm64`, same as bee.
2. **`scripts/check-binaries.js`**: check `ant-bin/<dir>/antd[.exe]` instead of
   `bee-bin/<dir>/bee` (`check-binaries.js:79-83`); update the
   `npm run bee:download` hint (`check-binaries.js:117`).
3. **`package.json` scripts** (`package.json:40-45`): add
   `ant:download/init/start/stop/status/reset` pointing at the new scripts and
   `ant-bin/.../antd`. Update any `dist:*`/CI references that call
   `bee:download` / `check-binaries`.
4. **`package.json` `build.extraResources`** (`package.json:136-137,157`):
   `bee-bin/${os}-${arch}/` → `ant-bin/...`; `config/bee.yaml` → `config/ant.yaml`
   `to: ant.yaml` (the config *filename* is Ring 2; keys stay).

> Decision: keep the **old `bee:*` scripts + `fetch-bee.js` as a fallback path**
> through Phase 5 (design doc §6 "keep bee as fallback"). Remove in a later
> cleanup once Ant has soaked.

### 3B — Ring 1 presentation rename ("Bee" → "Ant" where it means the node)

Decision rule (design doc §3): a string meaning *the node software* → **Ant**;
a string meaning *the Swarm network* → leave **Swarm**. Do **not** touch
protocol/`bee-js`/config-keys (Ring 0).

Primary user-facing files (from the repo `grep`, highest-density first):

- `src/renderer/lib/wallet/publish-setup.js` (43) — publish flow copy.
- `src/renderer/lib/menus.js` (33) — menu labels / node name.
- `src/renderer/lib/wallet/node-status.js` (24) — status pills.
- `src/renderer/index.html` (25) — "Bee wallet xBZZ", "once Bee has xDAI…".
- `src/renderer/lib/navigation.js` (12) — "Bee unreachable".
- `src/renderer/lib/settings-ui.js` (12) + `src/renderer/pages/settings.html`
  (12) — settings copy (keep existing "Swarm node" wording).
- `src/renderer/lib/wallet/swarm-readiness.js` (7) — "Bee is finishing
  light-node setup".
- `src/renderer/lib/wallet/publisher-identity-selector.js` (8),
  `funding-actions.js` (11), `stamp-manager.js` (4), `swarm-connect.js` (3),
  `chequebook-deposit.js` (4), `bee-api.js` (4 — strings only; module rename is
  Ring 2), `wallet-ui.js` (3).
- CSS labels: `services.css` (16), `menus.css` (6), `toolbar.css` (4) — only
  human-visible label text / class-driven copy, not selectors that other code
  depends on (treat class renames as Ring 2).
- Toasts/debug: `src/renderer/lib/bee-ui.js` (149 — strings here are Ring 1;
  the *file/module* rename is Ring 2 in Phase 4).
- The `assets/` node icon if bee-branded.
- README + `CHANGELOG.md` headline: **"Bee replaced by Ant."** (Phase 5 lands
  the changelog per `changelog-process.md`).

**Test churn:** renderer `.test.js` files assert on literal "Bee"
(e.g. `navigation.test.js` 112, `menus.test.js` 66, `settings-ui.test.js` 47,
`bee-ui.test.js` 133). Update expectations in lockstep — **string only, no
behavior change** (`AGENTS.md` rule 7).

**Gate (design doc §4 rebrand acceptance):**
`grep -rnE "Bee" src/renderer` returns only Ring-0/protocol or comments;
UI/menus/pills/settings/toasts read "Ant"; "Swarm" preserved where it means the
network. `npm run lint` + `npm test` green. A `dist` build fetches `antd` into
`ant-bin/` and the e2e suites (`test:e2e`, `test:e2e:onboarding`) pass.

### 3C — Headless e2e of Freedom-on-Ant in GitHub CI

Add an automated, headless e2e job so every PR proves Freedom boots, spawns
`antd`, and round-trips Swarm flows against the real Ant binary — not just unit
tests. Model it on the **existing** CI jobs in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (`e2e-onboarding-identity`,
`e2e-address-bar-clipboard`), which already run Electron headlessly on Linux via
`xvfb-run -a` and download the node binary with `GITHUB_TOKEN`.

**Approach (decided):** add a **standalone `e2e-ant` job** — do *not* fold Ant
into a `node: [bee, ant]` matrix on the existing jobs. A separate job keeps the
Ant leg isolated (own pin/tag, own failure surface, easy to mark required) and
leaves the current bee e2e jobs untouched as the fallback's coverage. It mirrors
the existing jobs' steps but swaps the download:

```yaml
e2e-ant:
  runs-on: ubuntu-latest          # Linux-first: cheapest headless leg.
  timeout-minutes: 20             # Optionally matrix to win/mac later.
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 20, cache: npm }
    - run: npm ci
    - if: runner.os == 'Linux'
      run: npx playwright install-deps
    - name: Download Ant binary
      run: npm run ant:download     # fetch-ant.js → ant-bin/<os>-<arch>/antd
      env:
        GITHUB_TOKEN: ${{ github.token }}
        ANT_RELEASE_TAG: v0.5.7     # pin until Ant cuts newer tags
    - run: npm run ipfs:download
      env: { GITHUB_TOKEN: ${{ github.token }} }
    - name: Run e2e against Ant (headless)
      run: xvfb-run -a npm run test:e2e:onboarding   # + test:e2e harness suite
    - if: failure()
      uses: actions/upload-artifact@v4
      with:
        name: e2e-ant-traces
        path: |
          test-results/
          playwright-report/
        retention-days: 14
```

Tasks:
1. `fetch-ant.js` (3A) must honor an `ANT_RELEASE_TAG`/pin env so CI can target a
   known-good tag (`v0.5.7`) instead of `latest`, and respect `GITHUB_TOKEN`
   (already done in `fetch-bee.js:12`) to dodge the unauthenticated rate limit.
2. The e2e suites must spawn the **bundled `antd`**, not reuse a stray daemon —
   set a throwaway data dir (`FREEDOM_BEE_DATA`, honored at `bee-manager.js:84`;
   renamed in Phase 4) and ensure nothing else holds `1633`
   (`detectExistingDaemon()`, `bee-manager.js:319`).
3. Cover the Swarm-critical specs: onboarding identity (spawns a real node +
   injects `keys/swarm.key`), plus a `harness`-project spec that does a bee-js
   upload/download round-trip. These are the flows the swap can break.
4. **Linux-first** to keep CI cheap; add a `os: [ubuntu, windows, macos]` matrix
   later if cross-platform `antd` regressions warrant it (the existing e2e jobs
   already use that matrix as a template, including the macOS signing caveat in
   §"Open items").
5. During rollout keep the **existing bee e2e jobs** green in parallel (they
   stay as-is — no matrix change) so the fallback path (design doc §6) stays
   covered until Ant soaks. `e2e-ant` is purely additive alongside them.

**Gate:** `e2e-ant` is required on PRs and green — Freedom launches, spawns
`antd`, `/health` passes within the 60 s poll, and the onboarding + upload/
download specs pass headlessly under `xvfb`.

---

## Phase 4 — Ring 2 cleanup: internal identifiers + migrations (this repo)

Pure consistency; can trail the headline. Each item is a coordinated change.

1. **Binary + bundled dir** `bee-bin/<os>-<arch>/bee` → `ant-bin/.../antd`:
   `getBeeBinaryPath()` (`bee-manager.js:54-76`). Build-time only — **no user
   migration**. (Already partly done by Phase 3A packaging; finish the runtime
   resolver here.)
2. **User data dir** `userData/bee-data` → `userData/ant-data`
   (`getBeeDataPath()`, `bee-manager.js:78-106`). **Start fresh — do NOT copy
   the old cache.** Safe: identity is re-derived from the vault
   (`identity/derivation.js` `BEE_WALLET`, BIP-44 `m/44'/60'/0'/0/1`) and
   re-injected as `keys/swarm.key` on every start
   (`identity-manager.js` → `injection.injectBeeKey`). Old `bee-data` is left
   in place, unreferenced.
   - ⚠️ **Light/SWAP mode only:** chequebook lives in the statestore. With a
     fresh dir, **rediscover** the chequebook from chain (pass the known
     chequebook hint / let Ant's factory check find it) so a fresh dir does not
     redeploy on-chain. Ultra-light (default, `swap-enable:false`) is unaffected.
3. **Config filename** `config/bee.yaml` → `config/ant.yaml`: extraResources
   (done in 3A) + any runtime writer. Note: the runtime config is written as
   `config.yaml` inside the data dir (`bee-manager.js:37`,
   `buildBeeConfigContent` `:136`); the bundled template is `config/bee.yaml`.
   Keys unchanged (Ring 0).
4. **Settings keys** `beeNodeMode`, `startBeeAtLaunch` → ant-named
   (`src/main/settings-store.js` defaults; `bee-manager.js:110`;
   `settings.html` field ids; `settings-ui.js`). ⚠️ **Migrate old→new on load**
   so existing prefs carry over; cover in `settings-store.test.js`.
5. **Service-registry key** `'bee'` → `'ant'`: `registry`/`DEFAULTS.bee`/`MODE`
   flow through main + renderer (`service-registry.js`, `bee-manager.js`
   `updateService('bee', …)` etc., renderer `node-status.js`). Coordinated
   multi-file change — rename both ends together.
6. **IPC channels**: `BEE_START='bee:start'` … `BEE_CHECK_BINARY`
   (`src/shared/ipc-channels.js:12-16`) and `SWARM_ENSURE_BEE_WALLET_IDENTITY`
   (`ipc-channels.js:232`). Values are arbitrary; rename const names + string
   values + both ends (`bee-manager.js` handlers `:655`, preload, renderer) in
   one commit.
7. **Module/file renames** (do last; read
   `architecture-boundaries.md` first): `bee-manager.js`→`ant-manager.js`,
   `bee-ui.js`→`ant-ui.js`, `bee-api.js`→`ant-api.js`, identity integration
   tests `__tests__/integration/bee*.test.js`, plus each `.test.js` sibling.
   Pure churn; update all `require()`/import paths.

**Gate (design doc §4):** settings migration verified upgrade-in-place (not just
fresh install); fresh `ant-data` re-derives the **same** overlay/eth
(`GET /addresses` unchanged); light-mode chequebook rediscovered, not
redeployed; `npm run lint` + full `npm test`/e2e green.

---

## Phase 5 — Ship (this repo)

1. Land behind a channel/flag; **keep the bee fetch path as fallback** until Ant
   soaks (design doc §6).
2. Land the `CHANGELOG.md` headline "Bee replaced by Ant" per
   `docs/agent-playbooks/changelog-process.md`.
3. Run the full release validation: `npm run test:e2e`, `test:e2e:live`,
   `test:e2e:onboarding`; verify ENS `bzz://<name>.eth` via Freedom's own
   resolver (`ens-resolver.js`/`ens-prefetch.js`) — design doc §2 (ENS).
4. Follow `docs/agent-playbooks/release-process.md` for the release/tag/build.

---

## Open items to resolve before GA (from design doc §6)

- **ENS:** confirm Freedom resolves ENS client-side and does not rely on
  the node's `resolver-options`. Verify in `src/main/ens-resolver.js` /
  `ens-prefetch.js`. (Action before GA.)
- **macOS signing/notarization:** the Ant binary ships as an `extraResource` —
  confirm it gets the same hardened-runtime/signing treatment as bee
  (`scripts/macos-notary.js` / `dist:mac:*`).
- **External-daemon reuse:** if a real bee answers `1633`, Freedom reuses it and
  won't start Ant (`detectExistingDaemon()`, `bee-manager.js:319`). Note for
  testing: kill stray bee or use throwaway data dir + fallback port.
- **Don't over-rename Ring 0:** a blind find/replace of "bee"→"ant" that hits
  `bee-js`, config keys, or `swarm.key` breaks compatibility. The rings exist to
  prevent exactly this.

---

## Per-phase definition of done (checklist)

- [ ] Phase 0 — Ant binary smoked against Freedom dev (upload/download/health/SIGTERM).
- [ ] Ant-side prerequisites met — tracked upstream in the Ant project.
- [ ] Phase 3A — `fetch-ant.js` + `check-binaries.js` + npm scripts + packaging target `ant-bin`/`ant.yaml`; checksum verification wired.
- [ ] Phase 3B — Ring 1 strings read "Ant"; `grep "Bee" src/renderer` clean; tests updated; e2e green.
- [ ] Phase 3C — standalone `e2e-ant` CI job runs Freedom headlessly (xvfb) against the real `antd`, required + green on PRs; existing bee e2e jobs kept untouched in parallel during rollout.
- [ ] Phase 4 — data dir/config/settings/registry/IPC/module renames done; settings + identity migrations verified upgrade-in-place.
- [ ] Phase 5 — flag + bee fallback in place; changelog headline landed; release validation green.
