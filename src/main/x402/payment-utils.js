/**
 * Pure helpers shared between the detector and the sign-flow / IPC
 * layers. Lives in its own file so `intercept.js` and `sign-flow.js`
 * can both import without the intercept ↔ sign-flow circular that
 * forced an earlier duplication.
 */

const { getPermission } = require('./permissions');

/**
 * Pull `(chainId, asset, amount)` out of a PaymentRequired without
 * assuming V1 vs V2 field names. V1 uses `maxAmountRequired`, V2 uses
 * `amount`. Returns null if the network isn't CAIP-2 — the permission
 * store doesn't key non-EIP-155 caps and we don't auto-pay them.
 */
function paymentTuple(requirements) {
  const accept = requirements?.accepts?.[0];
  if (!accept) return null;
  if (typeof accept.network !== 'string' || !accept.network.startsWith('eip155:')) return null;
  const chainId = Number(accept.network.slice('eip155:'.length));
  if (!Number.isFinite(chainId)) return null;
  const amount = accept.amount ?? accept.maxAmountRequired;
  if (typeof amount !== 'string') return null;
  return { chainId, asset: accept.asset, amount };
}

/**
 * Single source of truth for "does an active per-origin cap cover
 * this charge?" Used by the detector's auto-pay branch and the
 * sidebar's `autoPay` state both. Returns null when no usable
 * permission exists (caller treats that as kind:'none'); otherwise
 * { covers, remaining, perm } so callers can format the cap and the
 * remaining headroom for the UI.
 */
function getPermissionCoverage(url, requirements) {
  const tuple = paymentTuple(requirements);
  if (!tuple) return null;
  let origin;
  try { origin = new URL(url).origin; } catch { return null; }
  const perm = getPermission(origin, tuple.chainId, tuple.asset);
  if (!perm) return null;
  const remaining = BigInt(perm.capAmount) - BigInt(perm.spentAmount);
  return {
    covers: BigInt(tuple.amount) <= remaining,
    remaining,
    perm,
  };
}

module.exports = { paymentTuple, getPermissionCoverage };
