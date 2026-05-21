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
  outgoingHeaderForVersion,
  getDetectedPayment,
  clearDetectedPayment,
  setPendingPayment,
} = require('./intercept');
const { grant: grantPermission } = require('./permissions');
const { paymentTuple } = require('./payment-utils');

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
 * @param {number} webContentsId
 * @param {{
 *   grant?: { capAmount: string, windowSeconds: number },
 *   detection?: { url: string, requirements: object, resourceType?: string },
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

  let origin;
  try { origin = new URL(detected.url).origin; }
  catch { throw new Error('Refusing to pay: unparseable URL'); }

  const client = await createVaultBackedX402Client(getActiveWalletIndex());
  const payload = await client.createPaymentPayload(detected.requirements);

  const headerValue = Buffer.from(JSON.stringify(payload)).toString('base64');
  const headerName = outgoingHeaderForVersion(detected.requirements.x402Version);
  const tuple = paymentTuple(detected.requirements);
  const payTo = detected.requirements?.accepts?.[0]?.payTo ?? null;

  setPendingPayment(webContentsId, detected.url, {
    header: headerName,
    value: headerValue,
    origin,
    chainId: tuple?.chainId,
    asset: tuple?.asset,
    amount: tuple?.amount,
    payTo,
    fromAddress: client.address,
  });
  clearDetectedPayment(webContentsId);

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
  // Subresources are left for x402-aware page JS to retry; the injector
  // matches the next request to the same URL and attaches the signature.
  if (detected.resourceType === 'mainFrame') {
    wc.loadURL(detected.url).catch((err) => {
      log.error(`[x402:sign] re-navigation failed: ${err.message}`);
    });
  } else {
    log.info(
      `[x402:sign] subresource ${detected.resourceType ?? '<unknown>'} 402 paid; ` +
      `awaiting page retry of ${detected.url}`
    );
  }
}

module.exports = {
  signAndQueueRetry,
  paymentTuple,
  X402_HEADERS,
};
