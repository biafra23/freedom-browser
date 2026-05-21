/**
 * x402 IPC.
 *
 * Five channels driven by the wallet sidebar (running in the host
 * browser-shell webContents, NOT in the webview that hit the 402).
 * All channels that operate on a specific tab take `webContentsId`
 * explicitly — the sender is the sidebar, not the paying webview.
 *
 *   x402:get-details(webContentsId) — return the parsed PaymentRequired
 *     the detector stashed for that webContents, plus asset metadata
 *     for amount formatting and the auto-pay state for cap rendering.
 *
 *   x402:approve({webContentsId, grant?}) — drive the vault-backed
 *     x402Client to sign, stash the signed header for the dispatcher
 *     to inject, optionally grant a per-origin allowance, and re-issue
 *     the original navigation.
 *
 *   x402:cancel({webContentsId}) — discard the detected payment and
 *     step the webview back one history entry (or about:blank if no
 *     back stack).
 *
 *   x402:get-receipts({limit?}) — recent payments for the Payments tab.
 *
 *   x402:get-all-permissions / x402:revoke-permission — allowance UI.
 *
 * Auto-pay (active cap covers the charge) doesn't go through these —
 * the detector calls signAndQueueRetry directly. See sign-flow.js.
 */

const { ipcMain, webContents } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { getToken, getTokenKey } = require('../token-registry');
const {
  getDetectedPayment,
  clearDetectedPayment,
  consumePendingUnlockResume,
} = require('./intercept');
const {
  revoke: revokePermission,
  revokeAllForOrigin,
  updatePermission,
  getAllPermissions,
} = require('./permissions');
const paymentHistory = require('../payment-history');
const { signAndQueueRetry } = require('./sign-flow');
const { paymentTuple, getPermissionCoverage } = require('./payment-utils');

// Cancel fallback when the webview has no back history. `about:blank` is
// safe everywhere — the user gets an empty page and the address bar so
// they can navigate away.
const CANCEL_FALLBACK_URL = 'about:blank';

// Resolve the asset entry the sidebar uses to format the amount as
// e.g. "0.01 USDC" instead of "10000 of 0x8335…". Returns null when
// the asset isn't in the (strict) tokens allowlist.
function lookupAsset(requirements) {
  const tuple = paymentTuple(requirements);
  if (!tuple) return null;
  return getToken(getTokenKey(tuple.chainId, tuple.asset)) ?? null;
}

// Sidebar consumes this to decide between "render Approve UI" vs
// "render Allow-extra UI" (over-cap branch is the same UX as 'none'
// today, but the sidebar surfaces the existing-but-insufficient cap
// for transparency).
function autoPayStateFor(url, requirements) {
  const coverage = getPermissionCoverage(url, requirements);
  if (!coverage) return { kind: 'none' };
  return {
    kind: coverage.covers ? 'cover' : 'over-cap',
    remaining: coverage.remaining.toString(),
    capAmount: coverage.perm.capAmount,
    expiresAt: coverage.perm.expiresAt,
  };
}

function registerX402Ipc() {
  // The tab-scoped handlers accept an explicit `webContentsId` from the
  // sidebar (which is the host webContents and doesn't know which
  // webview the 402 came from). For test ergonomics we also fall back
  // to `event.sender.id` — production callers pass it explicitly.
  ipcMain.handle(IPC.X402_GET_DETAILS, async (event, args = {}) => {
    const id = args.webContentsId ?? event.sender.id;
    const detected = getDetectedPayment(id);
    if (!detected) {
      return { success: false, error: 'No pending x402 payment for this tab' };
    }
    return {
      success: true,
      url: detected.url,
      requirements: detected.requirements,
      asset: lookupAsset(detected.requirements),
      autoPay: autoPayStateFor(detected.url, detected.requirements),
    };
  });

  ipcMain.handle(IPC.X402_APPROVE, async (event, args = {}) => {
    const id = args.webContentsId ?? event.sender.id;
    try {
      // Vault-unlock-resume path: if a locked-vault auto-pay stashed a
      // resume token, use the captured snapshot so a newer 402 that
      // replaced `detectedPayments[id]` during the unlock dialog can't
      // redirect the sign. The token also carries CAP authorization,
      // which threads into the inject-time withhold gate.
      const resume = consumePendingUnlockResume(id);
      if (resume) {
        await signAndQueueRetry(id, {
          grant: args.grant,
          detection: resume.detection,
          authorizedBy: resume.authorizedBy,
        });
        return { success: true };
      }
      // Standard approve path — user clicked Pay on the sidebar card.
      // detectedPayments may carry `authorizedBy` from a prior cap-
      // covered detection (defence in depth); sign-flow defaults to
      // MANUAL when undefined.
      const detected = getDetectedPayment(id);
      await signAndQueueRetry(id, {
        grant: args.grant,
        authorizedBy: detected?.authorizedBy,
      });
      return { success: true };
    } catch (err) {
      // Vault locked / unparseable URL / sdk error all surface verbatim
      // so the sidebar can prompt the right next step.
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.X402_CANCEL, async (event, args = {}) => {
    const id = args.webContentsId ?? event.sender.id;
    clearDetectedPayment(id);
    const wc = webContents.fromId(id);
    if (!wc) return { success: true };
    if (wc.canGoBack && wc.canGoBack()) {
      wc.goBack();
    } else {
      wc.loadURL(CANCEL_FALLBACK_URL).catch((err) => {
        log.error(`[x402:cancel] fallback navigation failed: ${err.message}`);
      });
    }
    return { success: true };
  });

  ipcMain.handle(IPC.X402_GET_ALL_PERMISSIONS, async () => {
    return { success: true, permissions: getAllPermissions() };
  });

  // Legacy x402-only receipts channel. Now a thin alias over the unified
  // payment-history store; new callers should use the `payments:*` IPC.
  ipcMain.handle(IPC.X402_GET_RECEIPTS, async (_event, { limit } = {}) => {
    return {
      success: true,
      receipts: paymentHistory.getRecent({ kind: paymentHistory.KINDS.X402, limit }),
    };
  });

  ipcMain.handle(IPC.X402_REVOKE_PERMISSION, async (_event, { origin, chainId, asset }) => {
    revokePermission(origin, chainId, asset);
    return { success: true };
  });

  ipcMain.handle(IPC.X402_REVOKE_ALL_FOR_ORIGIN, async (_event, { origin } = {}) => {
    revokeAllForOrigin(origin);
    return { success: true };
  });

  ipcMain.handle(IPC.X402_UPDATE_PERMISSION, async (_event, { origin, chainId, asset, capAmount, windowSeconds } = {}) => {
    try {
      const updated = updatePermission(origin, chainId, asset, { capAmount, windowSeconds });
      return { success: true, permission: updated };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerX402Ipc,
};
