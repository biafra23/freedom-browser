/**
 * Pure helpers shared between the detector and the sign-flow / IPC
 * layers. Lives in its own file so `intercept.js` and `sign-flow.js`
 * can both import without the intercept ↔ sign-flow circular that
 * forced an earlier duplication.
 */

const { getPermission } = require('./permissions');

// CAIP-2 prefix for EIP-155 chains — the only `network` shape our cap
// store can key on. V1 string networks ('base', 'ethereum', …) bail
// out before reaching the chainId/asset lookup.
const EIP155_PREFIX = 'eip155:';

/**
 * Pull `(chainId, asset, amount)` out of a single `accepts[]` entry.
 * Returns null if the network isn't CAIP-2 (V1 string networks +
 * malformed) — the permission store doesn't key non-EIP-155 caps and
 * we don't auto-pay them. V2's `amount` is the canonical field; the
 * zod schema strips unknown keys, so by the time a parsed entry
 * reaches us there's no `maxAmountRequired` to fall back to.
 */
function tupleFromAccept(accept) {
  if (!accept) return null;
  if (typeof accept.network !== 'string' || !accept.network.startsWith(EIP155_PREFIX)) return null;
  const chainId = Number(accept.network.slice(EIP155_PREFIX.length));
  if (!Number.isFinite(chainId)) return null;
  if (typeof accept.amount !== 'string') return null;
  return { chainId, asset: accept.asset, amount: accept.amount };
}

/**
 * Compatibility shim that resolves a requirements-shaped object to its
 * `accepts[0]` tuple. Pre-dates multi-accept iteration; new code should
 * iterate `accepts[]` explicitly (see `findCoveringPermission`) and call
 * `tupleFromAccept` on the selected entry. Slated for removal once
 * remaining single-accept callsites migrate (WP-MA.1 step 2).
 */
function paymentTuple(requirements) {
  return tupleFromAccept(requirements?.accepts?.[0]);
}

/**
 * Locked-in selection rule: iterate `accepts[]` in server order; the
 * first entry whose `(chainId, asset)` matches an active per-origin
 * cap with enough headroom for the entry's amount wins. The user's
 * cap was their consent contract for a specific asset, so we honor
 * the order they set it in — no cheapest-of / balance-aware switching.
 *
 * Returns `{ accept, tuple, perm, remaining }` on the winning entry,
 * or `null` if no entry is cap-covered. Caller passes the parsed
 * `accepts[]` array directly so the helper doesn't have to know about
 * the V1/V2 requirements wrapper shape.
 */
function findCoveringPermission(origin, accepts) {
  for (const accept of accepts ?? []) {
    const tuple = tupleFromAccept(accept);
    if (!tuple) continue;
    const perm = getPermission(origin, tuple.chainId, tuple.asset);
    if (!perm) continue;
    const remaining = BigInt(perm.capAmount) - BigInt(perm.spentAmount);
    if (BigInt(tuple.amount) <= remaining) {
      return { accept, tuple, perm, remaining };
    }
  }
  return null;
}

/**
 * Compatibility shim for callers that still pass the whole
 * `requirements` blob and need the sidebar's three-way state:
 * `{covers, remaining, perm}` on a found permission (covered OR
 * over-cap), or `null` when no permission exists. Can't delegate to
 * `findCoveringPermission` directly — that helper collapses
 * "permission exists but doesn't cover" to `null`, while the sidebar's
 * `autoPayStateFor` needs to surface the over-cap perm for UI. Slated
 * for removal once the IPC `autoPayStateFor` migrates (WP-MA.1 step 2).
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

module.exports = {
  tupleFromAccept,
  findCoveringPermission,
  paymentTuple,
  getPermissionCoverage,
};
