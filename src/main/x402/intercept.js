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

  // WP3 stops here — the 402 response renders normally. WP4 swaps this
  // to a redirect into the freedom://x402 interstitial.
  return null;
}

function injectPaymentSignatureHandler(details) {
  const key = pendingKey(details.webContentsId, details.url);
  const signed = pendingPayments.get(key);
  if (!signed) return null;

  pendingPayments.delete(key); // one-shot

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
  registerWebRequestHandler('onBeforeSendHeaders', 'x402-inject', injectPaymentSignatureHandler);
}

module.exports = {
  X402_HEADERS,
  installX402Interception,
  detectPaymentRequiredHandler,
  injectPaymentSignatureHandler,
  parsePaymentRequiredHeader,
  setPendingPayment,
  getDetectedPayment,
  clearDetectedPayment,
  clearAllPendingPayments,
  clearAllDetectedPayments,
  cleanupWebContents,
};
