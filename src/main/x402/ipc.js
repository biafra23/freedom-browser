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
  hasPendingApproval,
  getPendingApproval,
  settlePendingApproval,
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
    // When detectionId is provided, the lookup is strict — refusing to
    // serve a different detection's data avoids "user sees A's details
    // but actually approves B" if a newer 402 replaced the map slot
    // between the event and this round-trip. Falls back to the
    // tab-keyed entry only when the tab-keyed entry's detectionId still
    // matches the request (mainFrame approval-card path).
    //
    // When detectionId is not provided (legacy / mainFrame callers
    // that haven't been updated), fall back to the tab-keyed entry.
    const { detectionId } = args;
    const id = args.webContentsId ?? event.sender.id;

    let detected;
    if (detectionId) {
      detected = getPendingApproval(detectionId);
      if (!detected) {
        const stored = getDetectedPayment(id);
        if (stored && stored.detectionId === detectionId) {
          detected = stored;
        }
      }
      if (!detected) {
        return { success: false, error: 'No pending x402 payment for this detectionId' };
      }
    } else {
      detected = getDetectedPayment(id);
      if (!detected) {
        return { success: false, error: 'No pending x402 payment for this tab' };
      }
    }

    return {
      success: true,
      url: detected.url,
      requirements: detected.requirements,
      detectionId: detected.detectionId ?? detectionId ?? null,
      asset: lookupAsset(detected.requirements),
      autoPay: autoPayStateFor(detected.url, detected.requirements),
    };
  });

  ipcMain.handle(IPC.X402_APPROVE, async (event, args = {}) => {
    const id = args.webContentsId ?? event.sender.id;
    const { detectionId, grant } = args;

    // WP7.1 subresource path: detector is awaiting the approval Promise.
    // Settle it (the detector handler does sign + 307). Returns
    // `pending: true` so the renderer keeps the card in "Signing..."
    // state and waits for the x402:approval-result event — the actual
    // sign happens inside the detector after this IPC returns, and we
    // need to surface its success/failure back to the UI.
    if (detectionId && hasPendingApproval(detectionId)) {
      settlePendingApproval(detectionId, { approved: true, grant });
      return { success: true, pending: true };
    }

    // P1: stale detectionId must NOT silently fall through to the
    // tab-keyed mainFrame path. If A's card click arrives after B's
    // 402 has superseded A in main, we MUST refuse — falling through
    // would sign B (whatever's currently in detectedPayments[id]) and
    // re-create the "approved A, paid B" race we designed against.
    // Only allow fallback when the tab-keyed detection's detectionId
    // still matches (i.e. the mainFrame approval-card flow where the
    // map entry carries the same detectionId).
    if (detectionId) {
      const stored = getDetectedPayment(id);
      if (!stored || stored.detectionId !== detectionId) {
        return { success: false, error: 'Approval is stale — the detection has been superseded' };
      }
    }

    try {
      // Manual approve path (mainFrame) — user clicked Pay on the
      // sidebar card. `pendingUnlockResume` is intentionally NOT
      // consumed here; that token is dedicated to the locked-vault
      // auto-pay flow and only X402_RESUME_UNLOCK touches it. Mixing
      // the two would let a click on B's approval card consume A's
      // resume token and sign A.
      //
      // detectedPayments may carry `authorizedBy` if the auto-pay
      // detector tagged the map — pure defence-in-depth here, since the
      // normal cap-covered flow signs without UI and never reaches this
      // handler. sign-flow defaults to MANUAL when undefined.
      const detected = getDetectedPayment(id);
      await signAndQueueRetry(id, {
        grant,
        authorizedBy: detected?.authorizedBy,
      });
      return { success: true };
    } catch (err) {
      // Vault locked / unparseable URL / sdk error all surface verbatim
      // so the sidebar can prompt the right next step.
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.X402_REJECT, async (_event, args = {}) => {
    // Subresource approval-card reject. Settles the pending Promise with
    // approved:false; the detector returns null and the page sees the
    // 402. mainFrame paywall cancel still goes through X402_CANCEL.
    const { detectionId } = args;
    if (!detectionId) {
      return { success: false, error: 'detectionId required' };
    }
    const settled = settlePendingApproval(detectionId, { approved: false });
    return { success: true, settled };
  });

  ipcMain.handle(IPC.X402_RESUME_UNLOCK, async (event, args = {}) => {
    // Dedicated channel for the renderer's `handleAutoPayUnlock`. Pulls
    // the resume token (carrying the original detection snapshot + CAP
    // marker) and signs it. If the token is missing — TTL'd, already
    // consumed, or the user dismissed the unlock dialog — return a
    // distinct error so the renderer knows there's nothing to resume.
    const id = args.webContentsId ?? event.sender.id;
    try {
      const resume = consumePendingUnlockResume(id);
      if (!resume) {
        return { success: false, error: 'No pending unlock-resume for this tab' };
      }
      await signAndQueueRetry(id, {
        detection: resume.detection,
        authorizedBy: resume.authorizedBy,
      });
      return { success: true };
    } catch (err) {
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
