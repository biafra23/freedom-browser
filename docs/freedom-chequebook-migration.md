# Freedom chequebook migration (Bee → Ant), zero-touch via auto-update

## Goal

Ship the Ant-based Freedom to existing users over `electron-updater` and have
their **existing Swarm chequebook carried over automatically** — no manual step,
no pasted address, no re-funding. After the update, the publish flow must work
exactly as it did on Bee.

This is a **Freedom-side, one-time migration**. Ant keeps owning the ongoing
chequebook lifecycle (deploy / persist / reload / serve `GET /chequebook/address`)
as pure Bee parity; Freedom only carries the *existing* user's chequebook forward
so Ant adopts it instead of deploying a fresh one.

## Background: why a migration is needed

- The publish checklist deadlocks at **step 3 ("Chequebook and postage sync")**
  whenever the node reports no chequebook. Step 3 has no button and gates steps
  4–5, so "nothing is clickable." `chequebookDeployed` comes straight from
  `GET /chequebook/address` (`src/renderer/lib/wallet/publish-setup.js`).
- Bee auto-deploys a chequebook on first light start, persists it in its
  statestore, and serves it forever after. Ant (M1.0) does **not** auto-discover
  it; with a fresh statestore it reports the zero address.
- The chequebook's issuer is the **node EOA** (`beeWallet`, derivation
  `m/44'/60'/0'/0/1`), which is **identical under Bee and Ant** (both load it
  from the injected `keys/swarm.key`). So the existing chequebook already belongs
  to Ant's node identity — Ant just needs the address to adopt it.

## Why fully-automatic discovery is possible

The chequebook address is **not** precomputable: Bee's `SimpleSwapFactory`
deploys via `new ERC20SimpleSwap(...)` (`CREATE`, nonce-dependent), not `CREATE2`.
And Freedom has no indexed-explorer API (only a human `explorerUrl` in the chain
catalog).

But the address **is** discoverable from indexed on-chain events using only the
**public** node-wallet address (readable from `vault-meta.json` without unlocking
the vault), via the RPC provider Freedom already has (`getProvider(100)`):

1. **Filter the xBZZ `Transfer` event by indexed `from` = node wallet.**
   ERC-20 `Transfer(address indexed from, address indexed to, uint256)` indexes
   both `from` and `to`, so
   `eth_getLogs({ address: xBZZ, topics: [Transfer, pad(beeWallet)] })`
   returns only the node wallet's outgoing transfers — a tiny set. Any **funded**
   chequebook was deposited into by the node wallet (deploy-bootstrap deposit and
   `/chequebook/deposit` both do an ERC-20 transfer from the node EOA to the
   chequebook), so the chequebook is among the `to` addresses.
2. **Verify each candidate** cheaply over RPC:
   - `SimpleSwapFactory.deployedContracts(to) == true`, and
   - `ERC20SimpleSwap(to).issuer() == beeWallet`.
   The unique match is the chequebook.

This needs **no new dependency**, **no explorer key**, **no vault unlock**, and
**no read of Bee's private state**. It is a one-time, background, pure-RPC lookup.

> Alternative (not recommended as primary): read the address directly from the
> leftover `userData/bee-data/statestore` LevelDB, which survives auto-update.
> It's the most direct source but needs a LevelDB reader dependency (approval
> required) and couples Freedom to Bee's on-disk format, which the drop-in plan
> otherwise avoids. Keep only as a fallback if the dep is approved.

## End-to-end flow (no user action)

1. User on Bee-Freedom receives the Ant build via `electron-updater`; the app
   relaunches into the Ant build. `userData/bee-data` and the wallet vault meta
   persist across the update.
2. On first launch, a background migration reads `beeWallet` from
   `vault-meta.json` (works even while the vault is locked) and runs the on-chain
   lookup above. On success it persists the verified chequebook address keyed by
   `beeWallet`, and records migration state.
3. When the node next starts in light mode, Freedom seeds Ant with the recorded
   address so Ant **adopts** the existing chequebook instead of deploying a new
   one — preserving the funded balance.
4. Once Ant's `GET /chequebook/address` returns it, the publish dialog's step 3
   clears automatically. Migration is effectively complete.
5. If the lookup finds nothing (user never had a chequebook), Ant's bee-parity
   auto-deploy creates a fresh one. The app never blocks; worst case is a
   re-funded chequebook with old funds recoverable later.

## Ant-side ask (keeps secrets out of Freedom)

Ant's `--chequebook` currently requires a paired `--swap-key` (the issuer's
private key). In Freedom's model the issuer **is** the node EOA, whose key Ant
already loads from `keys/swarm.key`. Ask the Ant side to **default the SWAP issuer
key to the loaded node signing secret** when a chequebook is configured. Then
Freedom seeds Ant with only the **non-secret chequebook address** (plus the
public Gnosis RPC URL) — no private key ever enters a spawn env. Strongly
recommended for the auto-update path.

Ant must also (bee parity): persist the adopted chequebook in its data-dir and
reload it on restart, and auto-deploy only when none is configured/persisted
(so Freedom seeding always pre-empts a fresh deploy). See
`docs/ant-runtime-postage-brief.md` item 8.

## Implementation plan (Freedom)

- `src/main/swarm/chequebook-migration.js` (new): the discovery + verification
  + persistence + migration-state machine. Pure main-process; uses
  `provider-manager.getProvider(100)` and ethers `Contract`/`Interface`.
  - `discoverChequebook(beeWalletAddress)` → `0x…` | `null`
    (chunked `getLogs` on xBZZ `Transfer` filtered by `from`, then verify each
    `to` via factory `deployedContracts` + `issuer()`).
  - `runChequebookMigration()` → idempotent; no-op if already done or no vault.
- `src/main/identity-manager.js`: `getStoredChequebookAddress(beeWallet)` /
  `recordChequebookAddress(beeWallet, addr)` persisted in `vault-meta.json`
  (e.g. `meta.chequebookByWallet[addr.toLowerCase()]`), plus a
  `chequebookMigration` status field (`pending` | `done` | `none-found`).
- `src/main/wallet/chains.js`: add `swapFactory` to `CHAIN_METADATA[100].contracts`
  (the SimpleSwapFactory address Bee hardcodes for Gnosis — **confirm value**).
- `src/main/bee-manager.js`: in light-mode `startBee()`, if a verified chequebook
  is recorded for the current bee wallet and Ant hasn't adopted one yet, pass it
  to the spawn (`CHEQUEBOOK_ADDRESS` + `GNOSIS_RPC_URL` via `spawn(..., { env })`;
  no private key once the Ant swap-key default lands).
- `src/main/index.js`: kick off `runChequebookMigration()` once on startup
  (background, after IPC registration), and re-run after vault unlock.
- `src/renderer/lib/wallet/publish-setup.js`: optional belt-and-braces — when
  `evaluateSteps()` observes a non-zero `chequebookAddr`, fire-and-forget a record
  IPC so any node that reports one keeps the stored value fresh. (Needs a channel
  in `src/shared/ipc-channels.js` + a `preload.js` bridge method.)

## Known constants (verified against Bee source)

Verified against `ethersphere/bee` `master` @ `eadd67fd` (2026-06-05).

- Gnosis chainId: `100`.
- xBZZ token: `0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da`
  (already in `chains.js` as `contracts.bzzToken`).
- **SimpleSwapFactory (Gnosis mainnet): `0xc2d5a532cf69aa9a1378737d8ccdef884b6e7420`**
  — confirmed: Bee hardcodes this as `CurrentFactoryAddress` for mainnet in
  `pkg/config/chain.go`, and uses it whenever `--swap-factory-address` is unset
  (`pkg/node/chain.go::InitChequebookFactory`). Add it to
  `CHAIN_METADATA[100].contracts.swapFactory` in `src/main/wallet/chains.js`.
  (Bee testnet/Sepolia factory, for reference: `0x0fF044F6bB4F684a5A149B46D7eC03ea659F98A1`.)
- ABIs needed: ERC-20 `Transfer` event; `SimpleSwapFactory.deployedContracts(address)→bool`;
  `ERC20SimpleSwap.issuer()→address`.
- Scan start block: the xBZZ token (or factory) deploy block on Gnosis — a fixed
  constant, used as the lower bound for chunked `getLogs`.

### Funding path (the `from`-filter assumption) — confirmed

Bee funds the chequebook with an **ERC-20 `transfer` from the node EOA to the
chequebook contract**, so the indexed-`from` filter will surface it:

- `chequebook.(*service).Deposit` →
  `s.erc20Service.Transfer(ctx, s.address /* chequebook */, amount)`
  (`pkg/settlement/swap/chequebook/chequebook.go`). The sender is the node owner
  EOA; the recipient is the chequebook. This backs both `POST /chequebook/deposit`
  and the deploy-time initial deposit (`pkg/settlement/swap/chequebook/init.go`,
  which calls the same `Deposit`).

**Nuance:** the deploy *itself* is an EOA→factory transaction emitting
`SimpleSwapDeployed` — it is **not** a token transfer. And Bee's deploy-time
initial deposit is **skipped when `swap-initial-deposit` is `0`** (the Bee
default), so a chequebook can exist on-chain with zero deposits. That edge case
does **not** affect the target population: any user who actually published has a
**funded** chequebook (cheques require balance), and Freedom itself tops it up —
`stamp-service.js::autoDepositChequebookIfEmpty()` deposits 0.1 xBZZ via
`bee.depositTokens`. So for existing Freedom publishers there is always ≥1
`Transfer(from = node EOA, to = chequebook)` to key on.

If you want to also cover the deployed-but-never-funded case (not a publisher),
add a secondary discovery pass over the factory's `SimpleSwapDeployed` logs and
verify each via `issuer()` — heavier and unnecessary for the auto-update target,
so treat it as optional.

## Edge cases & robustness

- **`getLogs` range limits.** Public Gnosis RPCs cap ranges; chunk from the start
  block to head over the `FallbackProvider`. The indexed `from` filter makes each
  chunk return almost nothing, so it's cheap. Make it resilient and background —
  a flaky RPC degrades to "retry next launch," never "block startup."
- **Multiple candidates.** Pick the `to` that passes both `deployedContracts` and
  `issuer() == beeWallet`; if more than one, prefer the funded / most-recent.
- **No chequebook found.** Record `none-found`; let Ant auto-deploy fresh.
- **Funding-path assumption.** Confirm Bee funds the chequebook via an ERC-20
  `transfer` from the node EOA (deploy bootstrap + `/chequebook/deposit`) so the
  `from`-filter is guaranteed to surface it for anyone who actually published.
- **Ordering vs. Ant auto-deploy.** Seeding must win when an address exists, or a
  fresh deploy will strand the old funds. Gate Ant's auto-deploy on "no chequebook
  configured/persisted."
- **Idempotency.** Migration is safe to run repeatedly; it no-ops once `done` /
  `none-found` and re-verifies cheaply.

## Acceptance

1. Upgrade-in-place from a Bee build that had a funded chequebook → first Ant
   launch discovers and records the same chequebook address with no user action.
2. Ant starts in light mode and `GET /chequebook/address` returns the **existing**
   address (not a newly deployed one); chequebook balance is preserved.
3. Publish dialog step 3 clears automatically; no manual entry shown.
4. Fresh user with no prior chequebook → migration records `none-found`, Ant
   auto-deploys, publishing still works.
5. Offline / flaky RPC at first launch → migration retries on a later launch;
   app remains fully usable meanwhile.
