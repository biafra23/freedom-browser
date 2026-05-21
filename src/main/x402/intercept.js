/**
 * x402 navigation interception — main-process plumbing.
 *
 * Two dispatcher handlers plus two state stores. No UI; the interstitial
 * + signing wiring lives in WP4.
 *
 *   `onHeadersReceived` (x402-detect)
 *     Detect `402` responses carrying a `PAYMENT-REQUIRED` header (V2)
 *     or `X-PAYMENT-REQUIRED` (V1-with-header). The base64-encoded JSON
 *     payload lands in `detectedPayments` keyed by `webContentsId` so a
 *     later interstitial wakeup can ask "what did the server want?"
 *
 *     V1 servers that ship payment requirements in the response *body*
 *     are not supported by this path — webRequest cannot read response
 *     bodies. Those servers fall through and the 402 page renders as-is;
 *     a `window.x402` capability in a later WP can serve in-page fetches
 *     where the body is visible.
 *
 *   `onBeforeSendHeaders` (x402-inject)
 *     When the interstitial has signed a `PaymentPayload` and the user is
 *     about to re-issue the original request, the signed header is
 *     stashed in `pendingPayments` keyed by `webContentsId|url`. The
 *     injector consumes the entry (one-shot) on the first matching
 *     request and attaches the right header for the protocol version.
 *
 * Both stores expose `clear*` helpers so tests can isolate state.
 */

const { webContents } = require('electron');

const log = require('../logger');
const { parsePaymentRequired } = require('@x402/core/schemas');
const { registerWebRequestHandler } = require('../webrequest-dispatcher');
const paymentHistory = require('../payment-history');
const { KINDS: PAYMENT_KINDS, STATUSES: PAYMENT_STATUSES } = paymentHistory;
const { getPermissionCoverage } = require('./payment-utils');
const { tryConsume } = require('./permissions');

// Header names used on the wire. V2 uses the un-prefixed names; V1 (Coinbase
// original) ships with the `X-` prefix. Centralised so WP4 callers reference
// the same constants the dispatch path checks.
const X402_HEADERS = Object.freeze({
  REQUIRED_V2: 'PAYMENT-REQUIRED',
  REQUIRED_V1: 'X-PAYMENT-REQUIRED',
  SIGNATURE_V2: 'PAYMENT-SIGNATURE',
  SIGNATURE_V1: 'X-PAYMENT',
  RESPONSE_V2: 'PAYMENT-RESPONSE',
  RESPONSE_V1: 'X-PAYMENT-RESPONSE',
});

const VALID_SIGNATURE_HEADERS = new Set([
  X402_HEADERS.SIGNATURE_V2,
  X402_HEADERS.SIGNATURE_V1,
]);

/**
 * Outgoing signature header name for a given protocol version. Lives next
 * to the constants so callers don't accidentally pair the wrong header
 * with the wrong version. Unknown versions default to V2 — zod-validated
 * input can only be 1 or 2, so the default just keeps a malformed payload
 * from crashing the renderer mid-flow.
 */
function outgoingHeaderForVersion(version) {
  return version === 1 ? X402_HEADERS.SIGNATURE_V1 : X402_HEADERS.SIGNATURE_V2;
}

// === State stores ========================================================

// "Server said this URL needs a payment." Keyed by webContentsId because
// the interstitial UI looks up "the latest detection for the tab the user
// is on." Replacing on each detection (rather than appending) matches a
// typical Chromium navigation: one 402 → one interstitial → one approval.
const detectedPayments = new Map();

// "User approved; here's the signed header ready to inject." Keyed by
// `webContentsId|url` so re-issuing the *exact* original URL on the
// *same* tab triggers the one-shot injection. Cross-tab key separation
// prevents two tabs pointed at the same paywalled URL from cross-feeding.
const pendingPayments = new Map();

// "We just injected a payment for this (tab, url) and expect a settlement
// response on the matching response." The receipt logger short-circuits
// to a Map.has check for the 99.99% of responses that aren't settlement
// responses, instead of iterating headers looking for the PAYMENT-RESPONSE
// name on every subresource fetch. Also tightens security: we only treat
// PAYMENT-RESPONSE headers from our own injected requests, never arbitrary
// server-side headers.
//
// The value is the receipt context — origin / chainId / asset / amount —
// that flows from approve through inject so the receipt the logger writes
// has everything the Payments tab needs to render.
const awaitingResponse = new Map();

function pendingKey(webContentsId, url) {
  return `${webContentsId ?? ''}|${url}`;
}

// Pending signatures expire after `PENDING_TTL_MS`. EIP-3009 carries its
// own `validAfter`/`validBefore` window (typically the requirements'
// `maxTimeoutSeconds`, default 60s), so even if a stale signature were
// somehow attached the facilitator would reject it; this is hygiene to
// keep the Map from accumulating stranded signatures across long-lived
// sessions and to avoid attaching a long-stale signature to a same-URL
// request that happens to fire much later.
const PENDING_TTL_MS = 60_000;

/**
 * Stash a signed PAYMENT-SIGNATURE / X-PAYMENT header for the dispatcher
 * to attach on the matching retry. One-shot — consumed by the first
 * matching request to `(webContentsId, url)` or dropped past `expiresAt`.
 *
 * `signed.header` + `signed.value` are validated strictly — a typo there
 * would silently fail the payment. Receipt-context fields (`origin`,
 * `chainId`, `asset`, `amount`, `payTo`, `fromAddress`) ride along
 * untouched; the injector copies them into the receipt context, and the
 * receipts module validates its own input, so this validator stays
 * focused on the bytes that actually go on the wire. Callers are trusted
 * in-process code (only `sign-flow.js`).
 *
 * @param {number} webContentsId
 * @param {string} url
 * @param {{
 *   header: 'PAYMENT-SIGNATURE' | 'X-PAYMENT',
 *   value: string,
 *   origin?: string, chainId?: number, asset?: string, amount?: string,
 *   payTo?: string, fromAddress?: string,
 * }} signed
 */
function setPendingPayment(webContentsId, url, signed) {
  if (!signed || !VALID_SIGNATURE_HEADERS.has(signed.header)) {
    throw new Error(`x402: invalid pending-payment header: ${signed?.header}`);
  }
  if (typeof signed.value !== 'string' || signed.value.length === 0) {
    throw new Error('x402: pending-payment value must be a non-empty string');
  }
  pendingPayments.set(pendingKey(webContentsId, url), {
    ...signed,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

function getDetectedPayment(webContentsId) {
  return detectedPayments.get(webContentsId) ?? null;
}

function clearDetectedPayment(webContentsId) {
  detectedPayments.delete(webContentsId);
}

function clearAllPendingPayments() {
  pendingPayments.clear();
}

function clearAllDetectedPayments() {
  detectedPayments.clear();
}

/**
 * Drop any state held for a webContents that is going away. Called from
 * the `'destroyed'` handler in `webcontents-setup.js` — without it, a tab
 * that hits a 402 (or gets an interstitial-approved pending payment) and
 * then closes leaks one Map entry per such tab over the session.
 */
function cleanupWebContents(webContentsId) {
  detectedPayments.delete(webContentsId);
  const prefix = `${webContentsId}|`;
  // Snapshot keys before mutating — Map iteration is safe under delete in
  // V8 today but the snapshot keeps the invariant explicit.
  for (const key of [...pendingPayments.keys()]) {
    if (key.startsWith(prefix)) {
      pendingPayments.delete(key);
    }
  }
  for (const key of [...awaitingResponse.keys()]) {
    if (key.startsWith(prefix)) {
      awaitingResponse.delete(key);
    }
  }
}

// === Header parsing ======================================================

// Electron's responseHeaders dict is `{ HeaderName: ['value', ...] }`
// with arbitrary casing — the same server can return `Payment-Required`
// or `PAYMENT-REQUIRED`. Match case-insensitively, return the first
// value.
function getHeaderValue(headers, name) {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return null;
}

/**
 * Decode a base64-encoded JSON PaymentRequired header and validate it
 * against `@x402/core`'s zod schema (handles V1 + V2 via a discriminated
 * union on `x402Version`). Returns `null` on any parse, base64, or schema
 * failure so the caller can fail open and just render the 402 page.
 *
 * @param {string} value
 * @returns {object | null}
 */
function parsePaymentRequiredHeader(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  const result = parsePaymentRequired(parsed);
  return result.success ? result.data : null;
}

// Strip query + fragment for logs; the URL might carry tokens the user
// would rather not see in logfiles.
function sanitizeUrlForLog(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

// Electron exposes `statusLine` as e.g. "HTTP/1.1 402 Payment Required"
// or "HTTP/2 402 …". `statusCode` is not in the details object Electron
// 30+ ships, so we check for the space-padded code inside the line —
// avoids an array allocation per response (this fires on every response,
// including subresources, so it's a hot path).
function isStatus402(statusLine) {
  return typeof statusLine === 'string' && statusLine.includes(' 402 ');
}

// 2xx detection for the receipt logger. "HTTP/1.1 200 OK" / "HTTP/2 204"
// both qualify; non-2xx responses (auth failures, server errors) land as
// receipts with status:'failed' so the user can see "I signed but got
// nothing back."
function isStatus2xx(statusLine) {
  if (typeof statusLine !== 'string') return false;
  return / 2\d\d(?: |$)/.test(statusLine);
}

// Fire an event at the HOST window's renderer (the browser shell that
// owns the sidebar). The webview that hit the 402 is a child of the
// host webContents; sending to host puts the event in front of the
// wallet sidebar UI.
function sendToHost(webviewWebContentsId, channel, payload) {
  const wc = webContents.fromId(webviewWebContentsId);
  const host = wc?.hostWebContents;
  if (!host) {
    log.warn(`[x402] no host webContents for ${webviewWebContentsId}; ${channel} dropped`);
    return;
  }
  host.send(channel, payload);
}

// === Dispatcher handlers =================================================

function detectPaymentRequiredHandler(details) {
  if (!isStatus402(details.statusLine)) return null;

  // Electron sets `webContentsId` undefined (or -1) for requests not tied
  // to a renderer — service workers, favicon discovery, Chromium-internal
  // metadata fetches. We can't re-navigate those, so even if they 402
  // there's nothing useful we can do.
  if (typeof details.webContentsId !== 'number' || details.webContentsId < 0) {
    log.info(
      `[x402:detect] 402 on ${sanitizeUrlForLog(details.url)} not tied to a webContents; ignoring`
    );
    return null;
  }

  const v2 = getHeaderValue(details.responseHeaders, X402_HEADERS.REQUIRED_V2);
  const v1 = getHeaderValue(details.responseHeaders, X402_HEADERS.REQUIRED_V1);
  const headerValue = v2 ?? v1;
  if (!headerValue) {
    log.info(
      `[x402:detect] 402 on ${sanitizeUrlForLog(details.url)} with no payment header — server is not x402, or uses body-only V1`
    );
    return null;
  }

  const requirements = parsePaymentRequiredHeader(headerValue);
  if (!requirements) {
    log.warn(
      `[x402:detect] PAYMENT-REQUIRED on ${sanitizeUrlForLog(details.url)} could not be parsed; ignoring`
    );
    return null;
  }

  // The data's own x402Version field is the canonical protocol version
  // (zod's discriminated union routed parsing through V1 or V2 already).
  // The header name we found it under is correlated but redundant.
  //
  // `resourceType` decides whether the retry can use `wc.loadURL` (a top-
  // level navigation; correct for `mainFrame`) or has to leave the tab
  // alone (subresource fetches — wc.loadURL would yank the user off the
  // page that initiated the fetch). See sign-flow.js for the gate.
  detectedPayments.set(details.webContentsId, {
    url: details.url,
    requirements,
    resourceType: details.resourceType,
    detectedAt: Date.now(),
  });
  log.info(
    `[x402:detect] v${requirements.x402Version} payment required for ${sanitizeUrlForLog(details.url)}`
  );

  // Auto-pay branch — if an active cap covers this charge, sign and
  // re-navigate silently. Deferred via setImmediate so we don't block
  // Chromium on the vault round-trip; the original 402 response will
  // render briefly while the retry kicks off.
  if (getPermissionCoverage(details.url, requirements)?.covers) {
    log.info(`[x402:detect] active cap covers ${sanitizeUrlForLog(details.url)} — auto-paying`);
    const id = details.webContentsId;
    const url = details.url;
    // Snapshot the detection at schedule time. Without this, a second
    // 402 on the same tab firing between this setImmediate and its run
    // would replace `detectedPayments[id]`, and the auto-pay would sign
    // the new charge using the (already-passed) cap check for the old
    // one. The IPC approve path retains its lookup-by-id behaviour;
    // full request-keyed state for both paths is future work.
    const detection = { url, requirements, resourceType: details.resourceType };
    setImmediate(() => {
      // Lazy require to dodge the intercept ↔ sign-flow circular dep.
      const { signAndQueueRetry } = require('./sign-flow');
      signAndQueueRetry(id, { detection }).catch((err) => {
        // Vault auto-locked between detection and sign: the cap already
        // authorised the charge, so we don't need a fresh approval — just
        // a vault unlock. Fire an event at the sidebar; on unlock it'll
        // call x402:approve which resumes sign-flow against the same
        // still-detected payment.
        if (err?.message === 'Vault is locked') {
          log.info(`[x402:auto-pay] vault locked — requesting unlock for ${sanitizeUrlForLog(url)}`);
          sendToHost(id, 'x402:unlock-needed', { webContentsId: id, origin: new URL(url).origin });
          return;
        }
        log.error(`[x402:auto-pay] failed: ${err.message}\n  cause: ${err.cause?.message || '(none)'}\n  stack: ${err.stack}`);
      });
    });
    return null;
  }

  // Otherwise fire the approval event at the host renderer; the
  // sidebar will pop up an approval card.
  sendToHost(details.webContentsId, 'x402:approval-needed', {
    webContentsId: details.webContentsId,
    url: details.url,
    requirements,
  });
  return null;
}

// onHeadersReceived (chained after detect). On a successful retry the
// server sends a PAYMENT-RESPONSE header carrying base64-encoded
// settlement metadata (incl. txHash). The receipt logger persists this
// to the Payments-tab ledger.
//
// Gated on `awaitingResponse` so we don't touch headers on every
// subresource fetch — the Map.has check is the fast-path miss for
// 99.99% of responses.
function paymentResponseLoggingHandler(details) {
  const key = pendingKey(details.webContentsId, details.url);
  const expected = awaitingResponse.get(key);
  if (!expected) return null;
  awaitingResponse.delete(key);

  const success = isStatus2xx(details.statusLine);
  let txHash = null;
  // V1 servers ship the settlement header as `X-PAYMENT-RESPONSE`; V2 drops
  // the `X-` prefix. Prefer the version matching what we signed, fall back
  // to the other so we don't miss a receipt because of header-name drift.
  const isV1 = expected.signedHeader === X402_HEADERS.SIGNATURE_V1;
  const canonical = isV1 ? X402_HEADERS.RESPONSE_V1 : X402_HEADERS.RESPONSE_V2;
  const fallback = isV1 ? X402_HEADERS.RESPONSE_V2 : X402_HEADERS.RESPONSE_V1;
  const value = getHeaderValue(details.responseHeaders, canonical)
    ?? getHeaderValue(details.responseHeaders, fallback);
  if (value) {
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
      if (typeof decoded.txHash === 'string') txHash = decoded.txHash;
    } catch {
      log.warn(
        `[x402:settled] PAYMENT-RESPONSE on ${sanitizeUrlForLog(details.url)} could not be decoded`
      );
    }
  }

  let status;
  if (!success) status = PAYMENT_STATUSES.FAILED;
  else if (txHash) status = PAYMENT_STATUSES.SETTLED;
  else status = PAYMENT_STATUSES.NO_RECEIPT;

  try {
    paymentHistory.append({
      kind: PAYMENT_KINDS.X402,
      url: expected.url,
      origin: expected.origin,
      chainId: expected.chainId,
      asset: expected.asset,
      amount: expected.amount,
      fromAddress: expected.fromAddress,
      toAddress: expected.payTo,
      txHash,
      status,
    });
  } catch (err) {
    log.error(`[x402:settled] receipt append failed: ${err.message}`);
  }

  if (txHash) {
    log.info(`[x402:settled] ${sanitizeUrlForLog(details.url)} txHash=${txHash}`);
  }
  return null;
}

function injectPaymentSignatureHandler(details) {
  const key = pendingKey(details.webContentsId, details.url);
  const signed = pendingPayments.get(key);
  if (!signed) return null;

  // Drop stale entries. The signed EIP-3009 authorisation has its own
  // validAfter/validBefore window — the facilitator would reject a stale
  // signature anyway — but we don't even want to attach it.
  if (signed.expiresAt && Date.now() > signed.expiresAt) {
    pendingPayments.delete(key);
    log.warn(`[x402:inject] pending signature expired for ${sanitizeUrlForLog(details.url)}; dropping`);
    return null;
  }

  pendingPayments.delete(key); // one-shot
  // Arm the receipt logger so it knows to look at THIS response for
  // the PAYMENT-RESPONSE settlement. We also hand off the receipt
  // context (origin / chainId / asset / amount) that the approve
  // handler stashed alongside the signed bytes — without it the
  // logger couldn't write a complete receipt. `signedHeader` lets the
  // receipt logger pick the V1 vs V2 settlement header.
  awaitingResponse.set(key, {
    url: details.url,
    origin: signed.origin,
    chainId: signed.chainId,
    asset: signed.asset,
    amount: signed.amount,
    payTo: signed.payTo ?? null,
    fromAddress: signed.fromAddress ?? null,
    signedHeader: signed.header,
  });

  // Burn the cap here, not at sign time — for subresource 402s where
  // the page might never retry, signing-without-consuming leaves the
  // cap intact. The cap check already passed at detection; a false
  // return here (two concurrent detections both passing before either
  // injected) doesn't block the inject because the signature is already
  // on the wire conceptually. Reservation/rollback would close that
  // overshoot window cleanly.
  if (signed.origin && signed.chainId && signed.asset && signed.amount) {
    const consumed = tryConsume(signed.origin, signed.chainId, signed.asset, signed.amount);
    if (!consumed) {
      log.warn(
        `[x402:inject] cap consume returned false for ${signed.origin} ${signed.amount} ` +
        `— charge proceeds (already signed) but cap accounting may be off`
      );
    }
  }

  log.info(
    `[x402:inject] attaching ${signed.header} to ${sanitizeUrlForLog(details.url)}`
  );
  return {
    requestHeaders: {
      ...details.requestHeaders,
      [signed.header]: signed.value,
    },
  };
}

// === Installation ========================================================

function installX402Interception() {
  registerWebRequestHandler('onHeadersReceived', 'x402-detect', detectPaymentRequiredHandler);
  registerWebRequestHandler('onHeadersReceived', 'x402-receipt', paymentResponseLoggingHandler);
  registerWebRequestHandler('onBeforeSendHeaders', 'x402-inject', injectPaymentSignatureHandler);
}

module.exports = {
  X402_HEADERS,
  outgoingHeaderForVersion,
  installX402Interception,
  detectPaymentRequiredHandler,
  injectPaymentSignatureHandler,
  paymentResponseLoggingHandler,
  parsePaymentRequiredHeader,
  setPendingPayment,
  getDetectedPayment,
  clearDetectedPayment,
  clearAllPendingPayments,
  clearAllDetectedPayments,
  cleanupWebContents,
};
