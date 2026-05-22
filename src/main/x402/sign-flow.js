/**
 * Shared "sign + queue retry" flow.
 *
 * Two call sites:
 *   - Auto-pay path in the detector, fired when an active cap covers
 *     the charge — silent, no UI.
 *   - The x402:approve IPC handler, fired when the user clicks Approve
 *     in the sidebar.
 *
 * Both want the same sequence: pick up the latest detected payment
 * for the webContents, build the vault-backed x402 client, sign,
 * stash the signed header for the dispatcher to inject, optionally
 * grant a fresh per-origin allowance and consume against it, then
 * re-issue the original navigation. Extracting here keeps that
 * sequence in one place and dodges a circular ipc.js ↔ intercept.js
 * dependency.
 */

const { webContents } = require('electron');
const log = require('../logger');
const { createVaultBackedX402Client } = require('./client');
const { getActiveWalletIndex } = require('../identity-manager');
const {
  X402_HEADERS,
  AUTHORIZED_BY,
  outgoingHeaderForVersion,
  getDetectedPayment,
  clearDetectedPayment,
  setPendingPayment,
} = require('./intercept');
const { grant: grantPermission } = require('./permissions');
const { tupleFromAccept } = require('./payment-utils');

/**
 * Sign the currently-detected payment for `webContentsId` and queue a
 * retry of the original URL. Throws on any failure (vault locked, URL
 * unparseable, client error). Caller decides how to surface the error.
 *
 * `opts.detection` lets the caller pass an explicit snapshot of the
 * detection to sign — used by the auto-pay path so a second 402 firing
 * between setImmediate-schedule and setImmediate-run can't redirect the
 * sign to a different charge. When omitted (IPC approve path) we fall
 * back to looking up the current detection by webContentsId.
 *
 * `opts.authorizedBy` rides through to the pending payment so the inject
 * handler can withhold the signature if a cap-authorized auto-pay races
 * over the cap. Defaults to MANUAL — callers that aren't auto-pay should
 * omit it. The auto-pay path must pass CAP explicitly.
 *
 * `opts.selectedAccept` is the specific `accepts[]` entry to sign.
 * Multi-accept callers (detector's findCoveringPermission result, or
 * the IPC's selectedAcceptIndex resolution) pass it explicitly.
 * Detection records can also carry a `selectedAccept` field (set by
 * the auto-pay branch so its snapshot survives across the cap-locked
 * unlock-resume). Legacy callers that omit both default to
 * `accepts[0]` — preserves single-accept behavior during the WP-MA
 * migration.
 *
 * @param {number} webContentsId
 * @param {{
 *   grant?: { capAmount: string, windowSeconds: number },
 *   detection?: { url: string, requirements: object, resourceType?: string, selectedAccept?: object },
 *   selectedAccept?: object,
 *   authorizedBy?: 'cap' | 'manual',
 * }} [opts]
 */
async function signAndQueueRetry(webContentsId, opts = {}) {
  // `webContents.fromId` is native and throws a cryptic ABI-style error
  // for non-integer input. Reject early with something the caller can act on.
  if (typeof webContentsId !== 'number' || webContentsId < 0) {
    throw new Error(`x402: invalid webContentsId: ${webContentsId}`);
  }
  const detected = opts.detection ?? getDetectedPayment(webContentsId);
  if (!detected) throw new Error('No pending x402 payment for this tab');

  const selectedAccept = opts.selectedAccept
    ?? detected.selectedAccept
    ?? detected.requirements?.accepts?.[0];
  if (!selectedAccept) throw new Error('No accepts[] entry to sign');

  let origin;
  try { origin = new URL(detected.url).origin; }
  catch { throw new Error('Refusing to pay: unparseable URL'); }

  const client = await createVaultBackedX402Client(getActiveWalletIndex());
  // Pre-filter `accepts[]` down to the chosen entry so the SDK's default
  // first-of-filtered selector signs the right one. Avoids registering a
  // custom paymentRequirementsSelector for what is effectively a one-
  // entry choice at this point in the flow.
  const payload = await client.createPaymentPayload({
    ...detected.requirements,
    accepts: [selectedAccept],
  });

  const headerValue = Buffer.from(JSON.stringify(payload)).toString('base64');
  const headerName = outgoingHeaderForVersion(detected.requirements.x402Version);
  const tuple = tupleFromAccept(selectedAccept);
  const payTo = selectedAccept.payTo ?? null;

  setPendingPayment(webContentsId, detected.url, {
    header: headerName,
    value: headerValue,
    origin,
    chainId: tuple?.chainId,
    asset: tuple?.asset,
    amount: tuple?.amount,
    payTo,
    fromAddress: client.address,
    authorizedBy: opts.authorizedBy ?? AUTHORIZED_BY.MANUAL,
  });
  // Only clear the map when we sourced FROM it. With a snapshot we used
  // our own copy and clearing here would erase whatever detection has
  // since taken its place (e.g. a second 402 that fired during our async
  // sign and is now showing in the sidebar).
  if (!opts.detection) {
    clearDetectedPayment(webContentsId);
  }

  // `grant` (create-a-cap) is an explicit user action from the approval
  // card and happens here, at sign time. `tryConsume` (burn-from-cap)
  // lives in the inject handler so we only bump `spentAmount` when the
  // signature actually rides out on a real request — subresource 402s
  // that sign-but-never-retry must not burn cap headroom.
  if (tuple && opts.grant) {
    try {
      grantPermission(origin, tuple.chainId, tuple.asset, opts.grant.capAmount, opts.grant.windowSeconds);
    } catch (err) {
      log.warn(`[x402:sign] grant rejected: ${err.message}`);
    }
  }

  const wc = webContents.fromId(webContentsId);
  if (!wc) {
    log.warn(`[x402:sign] webContents ${webContentsId} vanished before re-navigation`);
    return;
  }
  // `wc.loadURL` is a tab-level navigation — correct when the 402 came
  // from a top-level navigation (the tab was *between pages*), but for
  // subresource 402s (xhr/fetch/media/image/...) it would evict the page
  // that initiated the fetch and replace it with the raw subresource URL.
  // Subresources don't navigate here at all; the detector's self-307
  // path (and the approval-card retry loop) returns the 307 directly
  // from onHeadersReceived. This function only stashes the pending
  // signature; the injector attaches it on the followed-redirect request.
  if (detected.resourceType === 'mainFrame') {
    wc.loadURL(detected.url).catch((err) => {
      log.error(`[x402:sign] re-navigation failed: ${err.message}`);
    });
  } else {
    log.info(
      `[x402:sign] subresource ${detected.resourceType ?? '<unknown>'} 402 paid; ` +
      `signature stashed for the self-307 follow-up to ${detected.url}`
    );
  }
}

module.exports = {
  signAndQueueRetry,
  X402_HEADERS,
};
