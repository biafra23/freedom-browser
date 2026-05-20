/**
 * x402 interstitial IPC.
 *
 * Three channels, all driven from the freedom://x402 page running inside
 * the webview that hit the 402:
 *
 *   x402:get-details — return the parsed PaymentRequired the detector
 *     stashed for this tab so the UI can render amount / asset / payTo.
 *
 *   x402:approve — drive the vault-backed x402Client to sign the
 *     PaymentPayload, stash it as the pending payment for this tab+URL,
 *     and re-issue the original navigation. The dispatcher's
 *     onBeforeSendHeaders picks the entry up and attaches the right
 *     header (PAYMENT-SIGNATURE for V2, X-PAYMENT for V1) on its way out.
 *
 *   x402:cancel — discard the detected payment and step the webview
 *     back one history entry (or to the homepage if there's no history).
 *
 * Every handler scopes its work to `event.sender.id` — the webContents
 * that *issued* the IPC. The interstitial page lives inside the same
 * webview that hit the 402, so the sender ID is identical to the
 * detect-time webContentsId we keyed the state stores against. Nothing
 * in the renderer needs to pass tab IDs around.
 */

const { ipcMain, webContents } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { createVaultBackedX402Client } = require('./client');
const { getToken, getTokenKey } = require('../token-registry');
const {
  outgoingHeaderForVersion,
  getDetectedPayment,
  clearDetectedPayment,
  setPendingPayment,
} = require('./intercept');
const {
  grant: grantPermission,
  getPermission,
  tryConsume,
  revoke: revokePermission,
  getAllPermissions,
} = require('./permissions');
const { getActiveWalletIndex } = require('../identity-manager');

// Cancel fallback when the webview has no back history. `about:blank` is
// safe everywhere — the user gets an empty page and the address bar so
// they can navigate away. Going to homeUrl would require resolving a
// renderer-side module from main; not worth the cross-process plumbing
// for a corner case.
const CANCEL_FALLBACK_URL = 'about:blank';

// Pull `(chainId, asset, amount)` out of a PaymentRequired without
// assuming V1 vs V2 field names. V1 uses `maxAmountRequired`, V2 uses
// `amount`. Returns null if the network isn't CAIP-2 — the permission
// store doesn't key non-EIP-155 caps and we don't auto-pay them.
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

// Resolve the asset entry the interstitial UI can use to format the amount
// as e.g. "$0.01 USDC" instead of "10000 of 0x8335…". V2 uses CAIP-2
// network strings (`eip155:8453`); V1 uses bare names (`base`). We only
// look up V2 here — V1 callers fall back to raw display. Returns null if
// the asset isn't in the (strict) allowlist we ship in tokens.json.
function lookupAsset(requirements) {
  const tuple = paymentTuple(requirements);
  if (!tuple) return null;
  return getToken(getTokenKey(tuple.chainId, tuple.asset)) ?? null;
}

// Render the auto-pay state for the interstitial: does an active cap
// for this origin/asset already cover this charge, or will the user
// have to approve?
function autoPayStateFor(url, requirements) {
  const tuple = paymentTuple(requirements);
  if (!tuple) return { kind: 'none' };
  let origin;
  try { origin = new URL(url).origin; } catch { return { kind: 'none' }; }
  const perm = getPermission(origin, tuple.chainId, tuple.asset);
  if (!perm) return { kind: 'none' };
  const remaining = BigInt(perm.capAmount) - BigInt(perm.spentAmount);
  if (BigInt(tuple.amount) <= remaining) {
    return {
      kind: 'cover',
      remaining: remaining.toString(),
      capAmount: perm.capAmount,
      expiresAt: perm.expiresAt,
    };
  }
  return {
    kind: 'over-cap',
    remaining: remaining.toString(),
    capAmount: perm.capAmount,
    expiresAt: perm.expiresAt,
  };
}

function registerX402Ipc() {
  ipcMain.handle(IPC.X402_GET_DETAILS, async (event) => {
    const detected = getDetectedPayment(event.sender.id);
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

  // Approve a payment. The optional `grant` arg is sent by the
  // interstitial when its "Allow up to $X for Y days" toggle is on —
  // we sign this payment AND persist the cap so subsequent matching
  // 402s skip the interstitial.
  ipcMain.handle(IPC.X402_APPROVE, async (event, { grant } = {}) => {
    const tabId = event.sender.id;
    const detected = getDetectedPayment(tabId);
    if (!detected) {
      return { success: false, error: 'No pending x402 payment for this tab' };
    }

    // Identify the paying origin BEFORE we sign — if the URL doesn't
    // parse, the cap policy can't apply, and silently paying anyway
    // would let a malformed-URL site bypass the user's allowance.
    let origin;
    try {
      origin = new URL(detected.url).origin;
    } catch {
      return { success: false, error: 'Refusing to pay: unparseable URL' };
    }

    let client;
    try {
      client = await createVaultBackedX402Client(getActiveWalletIndex());
    } catch (err) {
      // Most common cause: vault is locked. The renderer surfaces the
      // message verbatim so the user can take the unlock path.
      return { success: false, error: err.message };
    }

    let payload;
    try {
      payload = await client.createPaymentPayload(detected.requirements);
    } catch (err) {
      log.error(`[x402:approve] createPaymentPayload failed: ${err.message}`);
      return { success: false, error: err.message };
    }

    const headerValue = Buffer.from(JSON.stringify(payload)).toString('base64');
    const headerName = outgoingHeaderForVersion(detected.requirements.x402Version);

    setPendingPayment(tabId, detected.url, { header: headerName, value: headerValue });
    clearDetectedPayment(tabId);

    // Permission bookkeeping. Order matters: if the renderer passed a
    // fresh `grant` block, replace any existing cap (zeroes spent +
    // starts a new window) BEFORE consuming, so this payment counts
    // against the new cap rather than burning a stale half-spent one.
    const tuple = paymentTuple(detected.requirements);
    if (tuple) {
      if (grant) {
        try {
          grantPermission(origin, tuple.chainId, tuple.asset, grant.capAmount, grant.windowSeconds);
        } catch (err) {
          log.warn(`[x402:approve] grant rejected: ${err.message}`);
        }
      }
      // Bump spent against whichever cap is now active (newly granted
      // or pre-existing). `tryConsume` returns false silently if no
      // cap exists or this charge doesn't fit — both fine; the user
      // explicitly approved this single payment regardless.
      tryConsume(origin, tuple.chainId, tuple.asset, tuple.amount);
    }

    // Re-issue the original navigation. The dispatcher's inject handler
    // consumes the pending entry on the matching outbound request and the
    // server returns the paid resource. We deliberately don't await
    // loadURL — Electron resolves it when the page is fully loaded, which
    // can be many seconds for the paid content; the renderer is happy as
    // soon as the IPC returns and the interstitial can clean up.
    const wc = webContents.fromId(tabId);
    if (wc) {
      wc.loadURL(detected.url).catch((err) => {
        log.error(`[x402:approve] re-navigation failed: ${err.message}`);
      });
    } else {
      log.warn(`[x402:approve] webContents ${tabId} vanished before re-navigation`);
    }

    return { success: true };
  });

  ipcMain.handle(IPC.X402_GET_ALL_PERMISSIONS, async () => {
    return { success: true, permissions: getAllPermissions() };
  });

  ipcMain.handle(IPC.X402_REVOKE_PERMISSION, async (_event, { origin, chainId, asset }) => {
    revokePermission(origin, chainId, asset);
    return { success: true };
  });

  ipcMain.handle(IPC.X402_CANCEL, async (event) => {
    const tabId = event.sender.id;
    clearDetectedPayment(tabId);

    const wc = webContents.fromId(tabId);
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
}

module.exports = {
  registerX402Ipc,
};
