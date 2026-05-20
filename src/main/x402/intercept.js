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

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');

const log = require('../logger');
const { parsePaymentRequired } = require('@x402/core/schemas');
const { registerWebRequestHandler } = require('../webrequest-dispatcher');

// Header names used on the wire. V2 uses the un-prefixed names; V1 (Coinbase
// original) ships with the `X-` prefix. Centralised so WP4 callers reference
// the same constants the dispatch path checks.
const X402_HEADERS = Object.freeze({
  REQUIRED_V2: 'PAYMENT-REQUIRED',
  REQUIRED_V1: 'X-PAYMENT-REQUIRED',
  SIGNATURE_V2: 'PAYMENT-SIGNATURE',
  SIGNATURE_V1: 'X-PAYMENT',
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
// response on the matching response." The receipt-logging handler short-
// circuits to a Set.has check for the 99.99% of responses that aren't
// settlement responses, instead of iterating headers looking for the
// PAYMENT-RESPONSE name on every subresource fetch. Also tightens
// security: we only treat PAYMENT-RESPONSE headers from our own
// injected requests, never arbitrary server-side headers.
const awaitingResponse = new Set();

function pendingKey(webContentsId, url) {
  return `${webContentsId ?? ''}|${url}`;
}

/**
 * Store a signed payment header to attach on the next request to the
 * same (webContentsId, url) pair. Called by the interstitial after the
 * user approves and the x402Client has produced the payload.
 *
 * @param {number} webContentsId
 * @param {string} url
 * @param {{ header: 'PAYMENT-SIGNATURE' | 'X-PAYMENT', value: string }} signed
 */
function setPendingPayment(webContentsId, url, signed) {
  // Defence-in-depth: a typo in the caller's header constant would cause
  // a silent payment failure (the server wouldn't recognise the request),
  // which is exactly the kind of bug we never want in a payment path.
  if (!signed || !VALID_SIGNATURE_HEADERS.has(signed.header)) {
    throw new Error(`x402: invalid pending-payment header: ${signed?.header}`);
  }
  if (typeof signed.value !== 'string' || signed.value.length === 0) {
    throw new Error('x402: pending-payment value must be a non-empty string');
  }
  pendingPayments.set(pendingKey(webContentsId, url), signed);
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
  for (const key of [...awaitingResponse]) {
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

// `file://…/pages/x402.html` — same renderer-pages directory the rest of
// the app loads its internal pages from. Memoised because Electron's
// `app` isn't ready at module-load time; the first detection call
// resolves it.
let cachedInterstitialUrl = null;
function getInterstitialFileUrl() {
  if (cachedInterstitialUrl) return cachedInterstitialUrl;
  const filePath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'src', 'renderer', 'pages', 'x402.html')
    : path.join(__dirname, '..', '..', 'renderer', 'pages', 'x402.html');
  cachedInterstitialUrl = pathToFileURL(filePath).toString();
  return cachedInterstitialUrl;
}

// === Dispatcher handlers =================================================

function detectPaymentRequiredHandler(details) {
  if (!isStatus402(details.statusLine)) return null;

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
  detectedPayments.set(details.webContentsId, {
    url: details.url,
    requirements,
    detectedAt: Date.now(),
  });
  log.info(
    `[x402:detect] v${requirements.x402Version} payment required for ${sanitizeUrlForLog(details.url)}`
  );

  // Redirect the navigation to the interstitial. The page lives in the
  // same webview, so its IPC `event.sender.id` matches the webContentsId
  // we just keyed the state under — no query-string handoff needed.
  return { redirectURL: getInterstitialFileUrl() };
}

// onHeadersReceived (chained after detect). On a successful retry the
// server sends a PAYMENT-RESPONSE header carrying base64-encoded
// settlement metadata (incl. txHash). WP6 will surface this as a
// receipt; for now we just log it so devs can verify the round-trip.
//
// Gated on `awaitingResponse` so we don't iterate response headers on
// every subresource fetch — the Set.has check is the fast-path miss
// for 99.99% of responses.
function paymentResponseLoggingHandler(details) {
  const key = pendingKey(details.webContentsId, details.url);
  if (!awaitingResponse.has(key)) return null;
  awaitingResponse.delete(key);

  const value = getHeaderValue(details.responseHeaders, 'PAYMENT-RESPONSE');
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
    log.info(
      `[x402:settled] ${sanitizeUrlForLog(details.url)} txHash=${decoded.txHash ?? 'unknown'}`
    );
  } catch {
    log.warn(`[x402:settled] PAYMENT-RESPONSE on ${sanitizeUrlForLog(details.url)} could not be decoded`);
  }
  return null;
}

function injectPaymentSignatureHandler(details) {
  const key = pendingKey(details.webContentsId, details.url);
  const signed = pendingPayments.get(key);
  if (!signed) return null;

  pendingPayments.delete(key); // one-shot
  // Arm the receipt logger so it knows to look at THIS response's
  // headers (and only this one) for the PAYMENT-RESPONSE settlement.
  awaitingResponse.add(key);

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
  getInterstitialFileUrl,
  setPendingPayment,
  getDetectedPayment,
  clearDetectedPayment,
  clearAllPendingPayments,
  clearAllDetectedPayments,
  cleanupWebContents,
};
