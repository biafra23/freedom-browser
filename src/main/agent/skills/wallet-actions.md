---
name: wallet-actions
description: Procedural recipes for the user's wallet — read balances, sign messages, send transactions, verify payments
builtin: true
version: 1
risk: medium
---

# Wallet actions

Recipes for the wallet tool cluster. Load this skill when the user
asks for any wallet operation — it documents the canonical flows so
you don't have to derive them turn by turn.

## Common preflight

Before any wallet operation:

1. **Know which wallet you'll act with.** `wallet_get_account` returns
   the active one (default for sign / send). `wallet_list_accounts`
   returns all derived wallets if the user mentions one by name or
   address.
2. **Know which chain.** Most signing/sending tools require an
   explicit `chainId`. If the user names a chain ("Gnosis", "Ethereum
   mainnet", "Base"), use `wallet_list_chains` to translate to the
   numeric id. **Never invent or guess a chainId.**

## Native vs ERC-20 — DON'T conflate similarly-named tokens

Token names that look related are often on different chains and
behave differently. Always cross-reference `wallet_list_chains`
`nativeSymbol` before deciding whether to send native value or build
ERC-20 calldata. A few specific traps:

- **xDAI** is the **native** token of Gnosis (chainId 100). Use
  `valueNative` and no `data`. It is NOT the ERC-20 DAI.
- **DAI** is an ERC-20 stablecoin on Ethereum (chainId 1) and other
  chains. Use `value: "0"` and a transfer-ABI calldata.
- **ETH** is native on Ethereum (1), Base (8453), Arbitrum (42161),
  etc. — same symbol, different chains.
- **WETH** is the ERC-20 wrapped form, not native.
- **USDC** is always an ERC-20, never native — but the contract
  address differs per chain; look it up via `wallet_get_chain` or
  the chain registry.

Heuristic: if the token symbol matches the chain's `nativeSymbol`,
treat it as native. Otherwise it's an ERC-20.

## Send native currency (ETH, xDAI, etc.)

The user wants to send 0.05 ETH on mainnet:

1. `wallet_get_account` → confirm the active address is the one they
   want (or pass `address` explicitly)
2. `wallet_send_transaction({ to, chainId: 1, valueNative: "0.05",
   reason: "send 0.05 ETH to alice for ..." })`

**Always use `valueNative` for native amounts — pass the decimal
string ("0.05"), never multiply by 10^18 yourself. Small models
miscount zeros.** `value` (raw wei) exists for callers that already
have the integer.

**`to` accepts ENS names directly** — pass `vitalik.eth` or
`meinhard.eth` as-is, the tool resolves it internally and the
consent card shows both forms ("vitalik.eth → 0xd8dA…6045") so the
user can verify the resolution before approving. Do NOT pre-resolve
via `ens_resolve` — that's only for when the user wants the address
without sending. If resolution fails the tool throws a clear error
("Could not resolve ENS name: x.eth").

## Send an ERC-20 token (USDC, BZZ, etc.)

The user wants to send 1 USDC on Gnosis:

1. `wallet_list_chains` → confirm chainId 100 for Gnosis
2. `wallet_get_chain({ chainId: 100 })` → token contract addresses
   live in `chain.contracts` for some chains; otherwise the registry
   has them (decode-side lookup happens automatically)
3. Build calldata for `transfer(address,uint256)`:
   - selector: `0xa9059cbb`
   - 32-byte recipient address (left-padded with zeros)
   - 32-byte amount in token's smallest unit (USDC has 6 decimals, so
     1 USDC = 1000000 = `0x00...00f4240`)
4. `wallet_send_transaction({ to: <token contract>, chainId: 100,
   data: <calldata>, valueNative: "0", reason: "send 1 USDC to ..." })`

The consent card decodes the calldata and shows the user **"Action:
Transfer 1.0 USDC to 0x..."** instead of raw hex — they can verify
the amount and recipient before approving.

## Sign a message (SIWE / login)

For "Sign in With Ethereum" or any plain-string proof of address:

`wallet_sign_message({ message: "...", reason: "...", address? })` —
EIP-191. Signing implicitly with the active wallet unless `address`
overrides. The consent card shows the user the message + reason; the
vault unlocks on demand if locked.

## Sign typed data (EIP-712 — Permits, OpenSea listings)

`wallet_sign_typed_data({ typedData, reason, address? })`. The
consent card decodes the EIP-712 struct (Domain pills + Message
rows) so the user sees what they're authorising. Use this for any
structured signing — Permit, Permit2, OpenSea, off-chain orders.

## Verify a payment was received

When another agent (or the user) says "I paid you X" — or right after
your own `wallet_send_transaction` returns:

1. **Get the transaction hash.** From their message, or from your
   own send return value (the `txHash` field).
2. `wallet_get_transaction({ hash, chainId })` → snapshot of the tx
   including from / to / value / decoded action / status.
3. Verify each of these against what was promised:
   - `status === 'confirmed'` (not `pending`, not `failed`)
   - For native payments: `to === <your address from
     wallet_get_account>` and `valueFormatted >= <expected amount>`
   - For ERC-20 payments: `action.kind === 'erc20-transfer'`,
     `action.recipient === <your address>`, `action.tokenSymbol`
     matches expected, `action.formattedAmount >= <expected amount>`
4. If `status === 'pending'` and you want to wait for confirmation
   in-line, call `wallet_wait_for_transaction({ hash, chainId,
   timeoutMs: 30000 })`. On timeout, fall back to
   `wallet_get_transaction` to re-check without blocking again.
5. **If status / recipient / amount don't match what was promised —
   tell the user, don't proceed.** Don't infer good faith from a
   transaction that doesn't say what the counterparty claims.

## Switch chain

`wallet_switch_chain({ chainId })` updates the wallet sidebar and
emits `chainChanged` to any open dApp in the active tab. Only call
this when the user explicitly asks to switch, or when an open dApp
needs a different chain — never as a silent prerequisite for
wallet_get_balance / wallet_send_transaction (those take chainId
explicitly).

## ENS

- `ens_resolve({ name })` — `vitalik.eth` → 0x address
- `ens_reverse({ address })` — 0x address → primary name (or "no
  primary name set")
- `ens_resolve_contenthash({ name })` — to the bzz/ipfs/ipns URI
  behind an ENS website

If a tool returns "no record" treat that as normal — don't infer
one. If contenthash returns `RPC quorum failed` (a `conflict`
error), surface it as a security signal — the providers disagreed,
do not pick a winner.
