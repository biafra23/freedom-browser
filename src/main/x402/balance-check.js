/**
 * Pre-sign balance verification for the manual-approval x402 paths
 * (mainFrame `x402:approve` + the subresource approval-card retry
 * loop). Auto-pay paths intentionally skip this — the cap was the
 * user's consent contract and adding an RPC roundtrip per silent
 * cap-covered charge would break streaming-grade latency. See
 * `research/x402-multi-accept-ux.md` locked decision #7.
 *
 * Fresh RPC fetch at click time catches the "I just spent this
 * asset outside the browser" stale-cache failure mode loudly, rather
 * than letting the user wait for a failed settlement. `fetchTokenBalance`
 * bypasses both balance caches so the 30s wallet-UI cache TTL never
 * masks an actually-empty balance from this gate.
 *
 * Mirrors the `VAULT_LOCKED_MESSAGE` + `isVaultLockedError` sentinel
 * pattern from `wallet/vault-errors.js` — keep co-located here while
 * x402 is the only consumer; relocate to a sibling of vault-errors if
 * a second consumer appears.
 */

const log = require('../logger');
const { tupleFromAccept } = require('./payment-utils');
const { fetchTokenBalance } = require('../wallet/balance-service');

const INSUFFICIENT_BALANCE_MESSAGE = 'Balance changed — insufficient funds for this payment';

function isInsufficientBalanceError(err) {
  return err?.message === INSUFFICIENT_BALANCE_MESSAGE;
}

/**
 * Throws INSUFFICIENT_BALANCE_MESSAGE if the wallet at `address` holds
 * less than the accept's amount. Returns silently in the no-op cases
 * (vault locked, V1 string network, RPC failure) so signing proceeds
 * and any settlement-side failure becomes the next safety net. Callers
 * on the auto-pay path don't call this at all.
 *
 * @param {object} accept The selected accepts[] entry.
 * @param {string | null} address The active wallet's address.
 */
async function verifyBalanceOrThrow(accept, address) {
  const tuple = tupleFromAccept(accept);
  if (!tuple || !address) return;

  let balanceEntry;
  try {
    balanceEntry = await fetchTokenBalance(address, tuple.chainId, tuple.asset);
  } catch (err) {
    log.warn(`[x402:balance-check] balance fetch failed (${err.message}); proceeding without verify`);
    return;
  }

  if (typeof balanceEntry?.raw !== 'string') return;

  let have;
  try { have = BigInt(balanceEntry.raw); } catch { return; }
  if (have < BigInt(tuple.amount)) {
    throw new Error(INSUFFICIENT_BALANCE_MESSAGE);
  }
}

module.exports = {
  INSUFFICIENT_BALANCE_MESSAGE,
  isInsufficientBalanceError,
  verifyBalanceOrThrow,
};
