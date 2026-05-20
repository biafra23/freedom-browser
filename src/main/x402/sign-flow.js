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
const {
  grant: grantPermission,
  tryConsume,
} = require('./permissions');
const { paymentTuple } = require('./payment-utils');

/**
 * Sign the currently-detected payment for `webContentsId` and queue a
 * retry of the original URL. Throws on any failure (vault locked, URL
 * unparseable, client error). Caller decides how to surface the error.
 *
 * @param {number} webContentsId
 * @param {{ grant?: { capAmount: string, windowSeconds: number } }} [opts]
 */
async function signAndQueueRetry(webContentsId, opts = {}) {
  const detected = getDetectedPayment(webContentsId);
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

  if (tuple) {
    if (opts.grant) {
      try {
        grantPermission(origin, tuple.chainId, tuple.asset, opts.grant.capAmount, opts.grant.windowSeconds);
      } catch (err) {
        log.warn(`[x402:sign] grant rejected: ${err.message}`);
      }
    }
    tryConsume(origin, tuple.chainId, tuple.asset, tuple.amount);
  }

  const wc = webContents.fromId(webContentsId);
  if (wc) {
    wc.loadURL(detected.url).catch((err) => {
      log.error(`[x402:sign] re-navigation failed: ${err.message}`);
    });
  } else {
    log.warn(`[x402:sign] webContents ${webContentsId} vanished before re-navigation`);
  }
}

module.exports = {
  signAndQueueRetry,
  paymentTuple,
  X402_HEADERS,
};
