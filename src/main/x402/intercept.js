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
const crypto = require('crypto');

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

// Source of consent for a pending payment. `CAP` = auto-pay against an
// active per-origin allowance (the cap IS the consent — if it doesn't
// cover at inject time, the signature must be withheld). `MANUAL` =
// user explicitly clicked Pay in the sidebar (the click is the consent,
// independent of cap state). Used by `injectPaymentSignatureHandler`'s
// withhold gate.
const AUTHORIZED_BY = Object.freeze({
  CAP: 'cap',
  MANUAL: 'manual',
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

// "Auto-pay tried to sign but the vault was locked; the user will unlock
// via the sidebar and the dedicated x402:resume-unlock IPC will fire to
// resume." Keyed by webContentsId. The value carries a snapshot of the
// original detection PLUS its authorizedBy marker, so the resume signs
// the right charge with the right consent — even if a newer 402 has
// since replaced `detectedPayments[id]` while the unlock dialog was open.
// Source-separated from x402:approve so a manual approval click on a
// different charge cannot consume this token.
const pendingUnlockResume = new Map();

// Vault unlocks should be quick (Touch ID is instant; password is
// seconds). 5 minutes is generous and matches "user walked away then
// came back" — beyond that the page would normally have lost state too.
const UNLOCK_RESUME_TTL_MS = 5 * 60 * 1000;

// "A non-cap-covered subresource 402 is parked here, holding the
// dispatcher's onHeadersReceived callback open until the sidebar tells
// us the user approved or rejected." Keyed by detectionId (per-detection
// identity, distinct from webContentsId so a newer 402 on the same tab
// can't redirect the user's eventual click to a different charge — the
// P2b "approved A, paid B" race fix). Single-card UI: a newer detection
// supersedes any older entries for the same webContents.
//
// Each value: { resolve, reject, webContentsId, url, requirements,
// resourceType, createdAt }. resolve/reject are the Promise handles the
// detector awaits.
const pendingApprovals = new Map();

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
 * `authorizedBy` distinguishes the consent source for the inject-time
 * cap-consume gate; see `AUTHORIZED_BY`. Cap-authorized signatures
 * MUST NOT be attached if `tryConsume` fails at inject (race-over);
 * manual ones proceed regardless. Undefined is treated as MANUAL for
 * backward-compat with callers that predate the field.
 *
 * @param {number} webContentsId
 * @param {string} url
 * @param {{
 *   header: 'PAYMENT-SIGNATURE' | 'X-PAYMENT',
 *   value: string,
 *   authorizedBy?: 'cap' | 'manual',
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
  const now = Date.now();
  // Lazy sweep — naive pages that never retry would otherwise leave
  // entries stranded until tab destruction. Fires only when we're
  // already touching the Map, so no timer lifecycle to manage.
  for (const [k, entry] of pendingPayments) {
    if (entry.expiresAt && now > entry.expiresAt) {
      pendingPayments.delete(k);
    }
  }
  pendingPayments.set(pendingKey(webContentsId, url), {
    ...signed,
    expiresAt: now + PENDING_TTL_MS,
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

function clearAllAwaitingResponse() {
  awaitingResponse.clear();
}

/**
 * Stash a snapshot+authorizedBy for the unlock-resume path. Single slot
 * per tab — a second locked-vault auto-pay before unlock replaces the
 * first (consistent with how `detectedPayments` itself is single-slot).
 */
function setPendingUnlockResume(webContentsId, { detection, authorizedBy }) {
  pendingUnlockResume.set(webContentsId, {
    detection,
    authorizedBy,
    createdAt: Date.now(),
  });
}

/**
 * One-shot read of the unlock-resume token for `webContentsId`. Returns
 * `null` if absent or past TTL.
 */
function consumePendingUnlockResume(webContentsId) {
  const entry = pendingUnlockResume.get(webContentsId);
  if (!entry) return null;
  pendingUnlockResume.delete(webContentsId);
  if (Date.now() - entry.createdAt > UNLOCK_RESUME_TTL_MS) return null;
  return entry;
}

function clearAllPendingUnlockResume() {
  pendingUnlockResume.clear();
}

/**
 * Mint a detectionId. Prefers Electron's stable per-request `details.id`
 * (a non-negative integer) so the id is greppable in logs.
 */
function mintDetectionId(details) {
  if (typeof details?.id === 'number' && details.id >= 0) {
    return `req-${details.id}`;
  }
  return `gen-${crypto.randomUUID()}`;
}

/**
 * Create a pending approval entry and return a Promise the detector
 * awaits. Resolves with `{ approved: boolean, grant? }` when the user
 * decides (IPC), or rejects when the entry is aborted (tab destroyed,
 * superseded by a newer detection).
 */
function setPendingApproval(detectionId, ctx) {
  return new Promise((resolve, reject) => {
    pendingApprovals.set(detectionId, {
      resolve,
      reject,
      detectionId,
      webContentsId: ctx.webContentsId,
      url: ctx.url,
      requirements: ctx.requirements,
    });
  });
}

function hasPendingApproval(detectionId) {
  return pendingApprovals.has(detectionId);
}

function getPendingApproval(detectionId) {
  return pendingApprovals.get(detectionId) ?? null;
}

function settlePendingApproval(detectionId, decision) {
  const entry = pendingApprovals.get(detectionId);
  if (!entry) return false;
  pendingApprovals.delete(detectionId);
  entry.resolve(decision);
  return true;
}

function abortPendingApproval(detectionId, reason) {
  const entry = pendingApprovals.get(detectionId);
  if (!entry) return false;
  pendingApprovals.delete(detectionId);
  entry.reject(reason);
  return true;
}

function abortPendingApprovalsForTab(webContentsId, reason) {
  for (const [id, entry] of pendingApprovals) {
    if (entry.webContentsId === webContentsId) {
      abortPendingApproval(id, reason);
    }
  }
}

function clearAllPendingApprovals() {
  for (const [, entry] of pendingApprovals) {
    entry.reject(new Error('cleared'));
  }
  pendingApprovals.clear();
}

/**
 * Drop any state held for a webContents that is going away. Called from
 * the `'destroyed'` handler in `webcontents-setup.js` — without it, a tab
 * that hits a 402 (or gets an interstitial-approved pending payment) and
 * then closes leaks one Map entry per such tab over the session.
 */
function cleanupWebContents(webContentsId) {
  detectedPayments.delete(webContentsId);
  pendingUnlockResume.delete(webContentsId);
  // Abort any in-flight approval awaits for this tab — without this the
  // detector's `await` would hang forever and the dispatcher's
  // onHeadersReceived callback would never release.
  abortPendingApprovalsForTab(webContentsId, new Error('tab destroyed'));
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

// Stash the unlock-resume token + fire the sidebar event. Used by both
// the subresource self-307 path and the mainFrame setImmediate path
// when sign-flow throws "Vault is locked". The two paths converge on
// identical inputs (id, detection, url, CAP authorization), so keep the
// "what to do when the vault is locked mid-auto-pay" contract in one
// place. See `setPendingUnlockResume` / `X402_RESUME_UNLOCK` for the
// resume contract.
function requestVaultUnlockForAutoPay(webContentsId, detection, url) {
  setPendingUnlockResume(webContentsId, { detection, authorizedBy: AUTHORIZED_BY.CAP });
  sendToHost(webContentsId, 'x402:unlock-needed', {
    webContentsId,
    origin: new URL(url).origin,
  });
}

/**
 * Detect 402+PAYMENT-REQUIRED in a response and either auto-pay (cap
 * covers) or surface an approval card. Async so the cap-covered
 * subresource path can sign inline and return a same-URL 307 directive.
 *
 * Test contract: many tests in `intercept.test.js` and `ipc.test.js`
 * call this handler without awaiting and rely on the side effects
 * (`detectedPayments.set`, `sendToHost`, `setImmediate` scheduling)
 * happening synchronously before the first `await`. Preserve that
 * ordering when modifying this function.
 */
async function detectPaymentRequiredHandler(details) {
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

  // Loop guard: if `awaitingResponse` is armed for this (id, url), a
  // request we already signed is the one that just 402'd — the server
  // rejected our signature (broken facilitator, wrong wallet, expired
  // authorization, ...). This sits ABOVE the cap-coverage check on
  // purpose: if the rejected attempt consumed the last of the cap,
  // re-evaluating coverage would say "no cap" and fall into the
  // approval-card flow, prompting the user to re-authorise a charge we
  // already know the server is refusing. Pass through; the receipt
  // handler runs next, sees the failed signed attempt, and writes a
  // `failed` row the user can see.
  if (awaitingResponse.has(pendingKey(details.webContentsId, details.url))) {
    log.warn(
      `[x402:detect] 402 on a request we already signed (server rejected); ` +
      `not re-signing ${sanitizeUrlForLog(details.url)}`
    );
    return null;
  }

  // Auto-pay branch — if an active cap covers this charge, sign and
  // either (subresource) return a same-URL 307 redirect so Chromium
  // re-issues the request transparently with PAYMENT-SIGNATURE, or
  // (mainFrame) sign via setImmediate + wc.loadURL so we don't block
  // Chromium on the vault round-trip. The subresource path was
  // validated against the test rig end-to-end (lazy paragraphs +
  // fragmented MP4 video with Range headers); Chromium preserves
  // request headers, cookies, and credentials across the same-origin
  // redirect, so no custom protocol or paid-cache is needed.
  if (getPermissionCoverage(details.url, requirements)?.covers) {
    log.info(`[x402:detect] active cap covers ${sanitizeUrlForLog(details.url)} — auto-paying`);
    const id = details.webContentsId;
    const url = details.url;
    // Tag the stored detection with the consent provenance. The direct
    // auto-pay path passes authorizedBy explicitly to signAndQueueRetry.
    // The unlock-resume path uses the dedicated x402:resume-unlock IPC,
    // which prefers the resume token's CAP marker but also reads this
    // map-tag as defence-in-depth — without either, an unlock-resume
    // would default to MANUAL and bypass the inject-time withhold gate.
    detectedPayments.set(id, {
      ...detectedPayments.get(id),
      authorizedBy: AUTHORIZED_BY.CAP,
    });
    // Snapshot the detection at the point of decision. The mainFrame
    // path captures it for the setImmediate closure (so a second 402 on
    // the same tab firing between schedule and run can't replace
    // detectedPayments[id] and redirect the auto-pay to a different
    // charge). The subresource path uses it inline. The IPC approve path
    // has a parallel latent gap tracked separately; full request-keyed
    // state for both is future work.
    const detection = { url, requirements, resourceType: details.resourceType };

    if (details.resourceType !== 'mainFrame') {
      // SUBRESOURCE PATH: sign inline, return a same-URL 307 from this
      // onHeadersReceived handler. Chromium follows the redirect; the
      // followed request hits onBeforeSendHeaders where our existing
      // injector matches (webContentsId, url) and attaches
      // PAYMENT-SIGNATURE. Page never sees the 402.
      try {
        // Lazy require to dodge the intercept ↔ sign-flow circular dep.
        const { signAndQueueRetry } = require('./sign-flow');
        await signAndQueueRetry(id, { detection, authorizedBy: AUTHORIZED_BY.CAP });
        log.info(`[x402:auto-pay] subresource signed; returning 307 → ${sanitizeUrlForLog(url)}`);
        return {
          statusLine: 'HTTP/1.1 307 Temporary Redirect',
          responseHeaders: { Location: [url] },
        };
      } catch (err) {
        if (err?.message === 'Vault is locked') {
          log.info(`[x402:auto-pay] vault locked — letting the 402 through, requesting unlock`);
          requestVaultUnlockForAutoPay(id, detection, url);
          return null;
        }
        log.error(`[x402:auto-pay] sign failed: ${err.message}\n  stack: ${err.stack}`);
        return null;
      }
    }

    // MAINFRAME PATH (existing — unchanged). setImmediate so we don't
    // block Chromium on the vault round-trip; original 402 renders
    // briefly while wc.loadURL kicks off the retry.
    setImmediate(() => {
      // Lazy require to dodge the intercept ↔ sign-flow circular dep.
      const { signAndQueueRetry } = require('./sign-flow');
      signAndQueueRetry(id, { detection, authorizedBy: AUTHORIZED_BY.CAP }).catch((err) => {
        // Vault auto-locked between detection and sign: the cap already
        // authorised the charge, so we don't need a fresh approval —
        // just a vault unlock. Stash a resume token carrying THIS
        // detection's snapshot + CAP authorization so the unlock-resume
        // signs the right charge even if a newer 402 replaced
        // detectedPayments[id] while the unlock dialog was open.
        if (err?.message === 'Vault is locked') {
          log.info(`[x402:auto-pay] vault locked — requesting unlock for ${sanitizeUrlForLog(url)}`);
          requestVaultUnlockForAutoPay(id, detection, url);
          return;
        }
        log.error(`[x402:auto-pay] failed: ${err.message}\n  cause: ${err.cause?.message || '(none)'}\n  stack: ${err.stack}`);
      });
    });
    return null;
  }

  // Not cap-covered. The sidebar will pop an approval card. Two flows
  // from here:
  //
  // - mainFrame: fire the event and return null. The page renders the
  //   402 while the user decides; the sidebar's Approve button calls
  //   x402:approve, which signs + wc.loadURL via signAndQueueRetry.
  //   Existing behaviour, unchanged.
  //
  // - Subresource: hold onHeadersReceived open (await the approval
  //   Promise). On approve → sign + return 307; Chromium follows the
  //   redirect and our injector attaches PAYMENT-SIGNATURE on the
  //   followed request. The page's fetch resolves with paid bytes —
  //   never sees the 402. On reject → return null; the page sees the
  //   402. This is WP7.1 Option α (transparent).
  //
  // detectionId identifies THIS specific 402 across event payload, IPC
  // approve/reject, and the pendingApprovals Map. P2b fix: a newer 402
  // arriving on the same tab while the user is still deciding aborts
  // the older entry — the sidebar will have replaced the card anyway.
  const detectionId = mintDetectionId(details);
  abortPendingApprovalsForTab(details.webContentsId, new Error('superseded by newer 402'));
  detectedPayments.set(details.webContentsId, {
    ...detectedPayments.get(details.webContentsId),
    detectionId,
  });
  // Event payload includes `resourceType` so the renderer can pick the
  // right teardown IPC (subresource → x402:reject; mainFrame → x402:cancel
  // which also goBacks the webview).
  sendToHost(details.webContentsId, 'x402:approval-needed', {
    webContentsId: details.webContentsId,
    detectionId,
    url: details.url,
    requirements,
    resourceType: details.resourceType,
  });

  // Predicate kept inline rather than a shared helper because there are
  // only two callers (here and dapp-x402.js#reject). If a third appears,
  // extract.
  const isSubresource = details.resourceType && details.resourceType !== 'mainFrame';
  if (!isSubresource) {
    return null;
  }

  let decision;
  try {
    decision = await setPendingApproval(detectionId, {
      webContentsId: details.webContentsId,
      url: details.url,
      requirements,
    });
  } catch (err) {
    // Abort path: tab destroyed, superseded by newer 402, or Chromium
    // aborted our held-open response (the last is defensive — not seen
    // in smoke; if it ever fires, this log is how we find out).
    if (err?.message && /aborted|cancelled/i.test(err.message)) {
      log.warn(`[x402:approval] response aborted while waiting for user; webContentsId=${details.webContentsId}: ${err.message}`);
    } else {
      log.info(`[x402:approval] subresource approval aborted: ${err?.message ?? err}`);
    }
    return null;
  }

  if (!decision.approved) {
    log.info(`[x402:approval] subresource ${sanitizeUrlForLog(details.url)} rejected; passing 402 through`);
    return null;
  }

  try {
    const { signAndQueueRetry } = require('./sign-flow');
    await signAndQueueRetry(details.webContentsId, {
      detection: { url: details.url, requirements, resourceType: details.resourceType },
      authorizedBy: AUTHORIZED_BY.MANUAL,
      grant: decision.grant,
    });
    log.info(`[x402:approval] subresource ${sanitizeUrlForLog(details.url)} signed; returning 307`);
    // Tell the sidebar the card can close. The IPC approve handler
    // returned synchronously with `pending: true` before sign ran.
    sendToHost(details.webContentsId, 'x402:approval-result', {
      detectionId,
      success: true,
    });
    return {
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
      responseHeaders: { Location: [details.url] },
    };
  } catch (err) {
    log.error(
      `[x402:approval] sign failed AFTER user approved ${sanitizeUrlForLog(details.url)}: ` +
      `${err.message}\n  stack: ${err.stack}`
    );
    // Surface the failure to the sidebar so it can restore the card
    // to a clickable state and show the same vault-locked / sign-error
    // UI mainFrame already has.
    sendToHost(details.webContentsId, 'x402:approval-result', {
      detectionId,
      success: false,
      error: err.message,
    });
    return null;
  }
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

// Run the cap consume for an inject attempt and decide whether the
// signature is still authorized to go out. Returns `true` to withhold
// (caller must drop the pending entry and bail), `false` to proceed.
// See `AUTHORIZED_BY` for the consent model. `undefined` authorizedBy
// is intentionally treated as `MANUAL` — backward-compat with callers
// that predate the field.
function consumeOrWithhold(signed, urlForLog) {
  if (!signed.origin || !signed.chainId || !signed.asset || !signed.amount) {
    return false;
  }
  const consumed = tryConsume(signed.origin, signed.chainId, signed.asset, signed.amount);
  if (consumed) return false;
  if (signed.authorizedBy === AUTHORIZED_BY.CAP) {
    log.warn(
      `[x402:inject] cap raced over for ${urlForLog} (authorizedBy=cap); ` +
      `withholding signature, falling back to manual approval`
    );
    return true;
  }
  log.warn(
    `[x402:inject] cap consume returned false for ${signed.origin} ${signed.amount} ` +
    `(authorizedBy=${signed.authorizedBy ?? AUTHORIZED_BY.MANUAL}); charge proceeds, cap accounting may be off`
  );
  return false;
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

  if (consumeOrWithhold(signed, sanitizeUrlForLog(details.url))) {
    pendingPayments.delete(key); // one-shot even on withhold
    return null;
  }

  pendingPayments.delete(key); // one-shot on the happy path
  // Arm the receipt logger so it knows to look at THIS response for the
  // PAYMENT-RESPONSE settlement. `signedHeader` lets the receipt logger
  // pick the V1 vs V2 settlement header.
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
  AUTHORIZED_BY,
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
  clearAllAwaitingResponse,
  consumePendingUnlockResume,
  clearAllPendingUnlockResume,
  hasPendingApproval,
  getPendingApproval,
  settlePendingApproval,
  abortPendingApproval,
  abortPendingApprovalsForTab,
  clearAllPendingApprovals,
  cleanupWebContents,
};
