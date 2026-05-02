/**
 * ipfs:// and ipns:// protocol handlers
 *
 * Registers main-process handlers for the `ipfs:` and `ipns:` schemes
 * (standard, secure, streaming, CORS-enabled; see
 * `registerSchemesAsPrivileged` in `src/main/index.js`). Every
 * `ipfs://<cid|name>/<path>` and `ipns://<key|name>/<path>` request —
 * top-level navigation, sub-resource, `fetch`, media `Range`, CSS `url(...)`,
 * service worker — flows through one of these handlers instead of Chromium
 * going directly to the Kubo gateway.
 *
 * Why this lives in the main process and not the renderer's URL pipeline:
 *
 * Without a privileged scheme, `ipfs://` URLs were translated to the Kubo
 * path-gateway (`http://localhost:8080/ipfs/<cid>/`), Chromium followed
 * Kubo's built-in subdomain redirect to `<cidv1>.ipfs.localhost:8080`,
 * and the page origin became the gateway subdomain. DevTools, `window.location`,
 * cookies, localStorage, IndexedDB, and service workers all saw the gateway
 * origin. Pinning the page origin to `ipfs://<cid>/` (or `ipfs://<name>/`
 * for ENS-backed sites) requires Chromium to never see the gateway URL,
 * which means the transport hop has to happen in the main process.
 *
 * Kubo subdomain redirect contract (load-bearing):
 *
 * The gateway URL is built with `localhost` (not `127.0.0.1`) on purpose —
 * Kubo only emits its built-in subdomain-gateway redirect for the
 * `localhost` hostname. That redirect is what creates a per-CID origin
 * inside Kubo, and `_redirects` SPA fallbacks only work in that mode (see
 * the integration guard in `src/main/__tests__/integration/ipfs-subdomain-gateway.test.js`).
 *
 * So the request flow is:
 *   ipfs://name.eth/path
 *     → resolve ENS → fetch http://localhost:8080/ipfs/<cid>/path
 *     → Kubo replies 301 Location: http://<cidv1>.ipfs.localhost:8080/path
 *     → node's fetch follows the redirect transparently
 *     → handler streams the final body back as the response to the
 *       original ipfs:// request.
 *
 * If we surfaced the 301 to Chromium, Chromium would leave the `ipfs://`
 * origin and we would be back to the gateway-origin bug. So
 * `redirect: 'follow'` is mandatory, not a stylistic choice.
 *
 * Contract:
 *  - Single attempt per request. Kubo doesn't have Bee's cold-content
 *    transient-5xx characteristic, so no retry loop. (Add later if real-
 *    world reliability data warrants.)
 *  - 4xx and 5xx responses pass through to the page so SPAs that feature-
 *    detect missing endpoints can render their own fallback.
 *  - Response body is streamed (no buffering), so large files and media
 *    Range requests don't balloon memory. `Range` headers pass through
 *    unmodified — Kubo handles them natively.
 *  - Cross-transport mismatches return 404 with an explanatory body —
 *    typing `ipfs://name.eth` whose contenthash is `bzz` (or `ipns`) is
 *    treated as user intent and we don't silently switch transports. Same
 *    rule the bzz handler enforces.
 */

const log = require('../logger');
const { getIpfsGatewayUrl } = require('../service-registry');
const { resolveEnsContent } = require('../ens-resolver');
const { isEnsHost } = require('../../shared/origin-utils');
const {
  cidV0ToV1Base32,
  cidV1B58btcToBase32,
  ipnsMhToCidV1Base36,
} = require('../../shared/cid-utils');

// CIDv0 (Qm + 44 base58), CIDv1 base32 (baf...), CIDv1 base58btc (z...).
// Mirrors the validation in src/main/request-rewriter.js' isValidCid and
// the renderer's url-utils.js — keep all three in sync.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{50,}|z[1-9A-HJ-NP-Za-km-z]{40,})$/i;

// IPNS host: libp2p key (k51..., 12D3..., Qm...) or DNSLink name. Same
// shape Kubo accepts on /ipns/<host>. ENS hosts (.eth/.box) match this
// pattern too — the buildGatewayUrl branch order routes them to the ENS
// resolver instead of the raw IPNS branch.
const IPNS_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/;

// Request headers we should not forward to Kubo — either Chromium-injected
// privileged-scheme noise or headers that refer to the ipfs:// origin and
// would confuse the gateway. Mirrors the bzz handler's strip set.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'authorization',
  // Connection / hop-by-hop
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function sanitizeRequestHeaders(requestHeaders) {
  const out = new Headers();
  for (const [name, value] of requestHeaders.entries()) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out.append(name, value);
  }
  return out;
}

/**
 * Translate `<namespace>://<host>/<path>?<q>` into the Kubo gateway URL.
 *
 * `namespace` is `'ipfs'` or `'ipns'`. `<host>` is either:
 *  - a CID (ipfs) / IPNS key or DNSLink name (ipns), routed to the raw
 *    Kubo gateway path, OR
 *  - an ENS name (.eth/.box), resolved via the in-process ens-resolver
 *    cache. Resolving here (not just in the renderer's address-bar
 *    pipeline) is what makes `ipfs://name.eth/` survive as the URL
 *    Chromium loads — DevTools, `window.location`, storage origin, and
 *    subresource fetches all see the ENS name rather than the resolved
 *    CID.
 *
 * Returns one of:
 *  - `{ ok: true, url }`              — usable Kubo gateway URL.
 *  - `{ ok: false, status, message }` — semantic failure (404 mismatch /
 *    no contenthash, 415 unsupported codec, 502 resolver conflict/error).
 *  - `null`                           — malformed input. Caller emits 400.
 */
async function buildGatewayUrl(namespace, sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null;
  }

  let host = parsed.hostname;
  let pathname = parsed.pathname;
  let effectiveNs = namespace;

  // Gateway-form rewrite — see the equivalent comment in
  // `src/renderer/lib/url-utils.js#parseIpfsInput` for the full rationale.
  // Reaches here for sub-resource requests (`<img>`, `<script>`, `fetch`,
  // CSS `url(...)`, etc.) that bypass the renderer's address-bar pipeline
  // — top-level navigations get rewritten upstream so the address bar
  // and origin both end up canonical. Sub-resources keep the original
  // `ipfs://localhost/...` URL (and therefore the wrong storage origin)
  // but at least the bytes load.
  //
  // The gate is now an explicit known-public-gateway / loopback host
  // allowlist (see isKnownGatewayHost). Earlier versions used a negative
  // "host doesn't look like a content reference" check, which over-fired
  // for DNSLink hosts: e.g. `ipns://docs.ipfs.tech/ipfs/coverage` would
  // try to rewrite even though `docs.ipfs.tech` is the actual content
  // host (a DNSLink site that genuinely serves a `/ipfs/coverage` page).
  // Restricting the rewrite to outer hosts we recognize as gateways
  // disambiguates that case purely from the URL.
  //
  // `parsed.pathname` keeps original case (Chromium only lowercases the
  // host segment for standard schemes), so an embedded CIDv0, CIDv1
  // base58btc, or base58 IPNS key survives intact and can be
  // canonicalised below.
  if (isKnownGatewayHost(host)) {
    const gatewayMatch = pathname.match(/^\/(ipfs|ipns)\/([^/]+)(.*)$/);
    if (gatewayMatch) {
      const innerNs = gatewayMatch[1];
      const ref = gatewayMatch[2];
      // For /ipfs/, the embedded ref must be a CID (looksLikeContentKey).
      // For /ipns/, also accept DNSLink-shaped names so e.g.
      // `ipfs://dweb.link/ipns/docs.ipfs.tech/install` rewrites to
      // `ipns://docs.ipfs.tech/install`. ENS-style names (`*.eth`,
      // `*.box`) are valid DNSLink targets too and route through the
      // resolver branch below.
      const refOk =
        looksLikeContentKey(ref) || (innerNs === 'ipns' && isLikelyDnsLinkName(ref));
      if (refOk) {
        effectiveNs = innerNs;
        let embeddedRef = ref;
        if (innerNs === 'ipfs') {
          // CIDv0 (Qm…) → CIDv1 base32, OR CIDv1 base58btc (z…) → base32.
          const canonical = cidV0ToV1Base32(embeddedRef) || cidV1B58btcToBase32(embeddedRef);
          if (canonical) embeddedRef = canonical;
        } else if (looksLikeContentKey(embeddedRef)) {
          // Base58 peer ID → libp2p-key base36, or CIDv1 base58btc → base32.
          // DNSLink-shaped names skip canonicalisation and pass through.
          const canonical =
            ipnsMhToCidV1Base36(embeddedRef) || cidV1B58btcToBase32(embeddedRef);
          if (canonical) embeddedRef = canonical;
        }
        host = embeddedRef;
        pathname = gatewayMatch[3] || '/';
      }
    }
  }

  const gw = getIpfsGatewayUrl();

  if (effectiveNs === 'ipfs' && CID_RE.test(host)) {
    // CIDv0 / CIDv1-base58btc hosts are case-sensitive. Sub-resource
    // requests (`<img src="ipfs://Qm.../">`, `<img src="ipfs://z.../">`,
    // `fetch('ipfs://...')`, etc.) bypass the renderer's formatIpfsUrl
    // pipeline and arrive here with the host already lowercased by
    // Chromium's standard-scheme URL parser. If the original was
    // mixed-case we can re-encode to lowercase-canonical CIDv1 base32; if
    // it was already lowercase the original bytes are gone and we
    // surface a clear 400 instead of forwarding an invalid reference to
    // Kubo (whose 400 message is less actionable). CIDv1 base32 (`baf…`)
    // is already lowercase-canonical and falls through unchanged.
    if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/i.test(host)) {
      const canonical = cidV0ToV1Base32(host);
      if (canonical) {
        host = canonical;
      } else {
        return {
          ok: false,
          status: 400,
          message:
            `lowercased CIDv0 host "${host}" is not a valid IPFS reference. ` +
            `Chromium's standard-scheme URL parser lowercased the host segment ` +
            `and destroyed the case-sensitive base58btc encoding. Publish the ` +
            `resource with its CIDv1 base32 (bafy...) form for sub-resource use.`,
        };
      }
    } else if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(host)) {
      const canonical = cidV1B58btcToBase32(host);
      if (canonical) {
        host = canonical;
      } else {
        return {
          ok: false,
          status: 400,
          message:
            `lowercased CIDv1 base58btc host "${host}" is not a valid IPFS reference. ` +
            `Chromium's standard-scheme URL parser lowercased the host segment ` +
            `and destroyed the case-sensitive base58btc encoding. Publish the ` +
            `resource with its CIDv1 base32 (bafy...) form for sub-resource use.`,
        };
      }
    }
    return {
      ok: true,
      url: `${gw}/ipfs/${host}${pathname}${parsed.search}`,
    };
  }

  if (effectiveNs === 'ipns' && !isEnsHost(host) && IPNS_HOST_RE.test(host)) {
    // base58btc IPNS peer-ID hosts (`12D3Koo...`, `16Uiu2H...`, `Qm...`)
    // and CIDv1-base58btc IPNS keys (`z...` libp2p-key) are case-
    // sensitive; same recovery / rejection rule as CIDv0 above. Already-
    // canonical libp2p-key base36 (`k51...`) and DNSLink names are
    // lowercase and pass through unchanged.
    if (/^(12D3|16Uiu2H|Qm)/i.test(host)) {
      const canonical = ipnsMhToCidV1Base36(host);
      if (canonical) {
        host = canonical;
      } else {
        return {
          ok: false,
          status: 400,
          message:
            `lowercased base58btc IPNS host "${host}" is not a valid IPNS reference. ` +
            `Chromium's standard-scheme URL parser lowercased the host segment ` +
            `and destroyed the case-sensitive encoding. Publish the resource with ` +
            `its libp2p-key base36 (k51.../k2k4...) form for sub-resource use.`,
        };
      }
    } else if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(host)) {
      const canonical = cidV1B58btcToBase32(host);
      if (canonical) {
        host = canonical;
      } else {
        return {
          ok: false,
          status: 400,
          message:
            `lowercased CIDv1 base58btc IPNS host "${host}" is not a valid IPNS reference. ` +
            `Chromium's standard-scheme URL parser lowercased the host segment ` +
            `and destroyed the case-sensitive base58btc encoding. Publish the ` +
            `resource with its libp2p-key base36 (k51.../k2k4...) or CIDv1 base32 ` +
            `(bafy...) form for sub-resource use.`,
        };
      }
    }
    return {
      ok: true,
      url: `${gw}/ipns/${host}${pathname}${parsed.search}`,
    };
  }

  if (isEnsHost(host) && !hasEmptyLabel(host)) {
    return resolveEnsToGatewayUrl(effectiveNs, host, { pathname, search: parsed.search }, gw);
  }

  return null;
}

// Mirrored in src/renderer/lib/url-utils.js — kept in sync intentionally.
// (Not extracted to a shared module because the regexes are tiny and
// duplicating them avoids dragging more cross-context plumbing in.)
//
// Returns true for the embedded ref of a gateway-form path that we'll
// rewrite to the canonical `<scheme>://<ref>/...` form. Stricter than the
// full IPNS-host shape: ENS names are excluded here because their
// gateway-form embedded representation is vanishingly rare and ambiguous
// with arbitrary DNSLink subpaths; ENS routing happens at the outer host.
function looksLikeContentKey(ref) {
  if (typeof ref !== 'string' || !ref) return false;
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/i.test(ref)) return true;
  if (/^baf[a-z2-7]{50,}$/i.test(ref)) return true;
  if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(ref)) return true;
  if (/^k[a-z0-9]{40,}$/i.test(ref)) return true;
  if (/^(12D3|16Uiu2H)[a-zA-Z0-9]{30,}$/i.test(ref)) return true;
  return false;
}

// Hostname-shaped string with at least one dot — used to recognise
// DNSLink targets in the embedded ref of `ipfs://<gateway>/ipns/<name>/...`
// gateway-form URLs. RFC 1123-ish: dot-separated labels of alphanumerics
// and hyphens, label-internal-only hyphens, total length capped at the
// DNS limit. Only meaningful when the surrounding namespace is `ipns`
// — DNSLink doesn't apply under `/ipfs/`.
function isLikelyDnsLinkName(ref) {
  if (typeof ref !== 'string' || !ref) return false;
  if (ref.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(ref);
}

// Hosts we recognise as IPFS gateways for the gateway-form rewrite.
// Conservative allowlist: loopback variants plus the most common public
// gateways. Self-hosted gateways aren't matched here — but their content
// authors can publish canonical `ipfs://<cid>/...` URLs directly without
// needing the rewrite. The previous heuristic (any non-content-key host)
// over-fired on DNSLink hosts like `docs.ipfs.tech`.
const KNOWN_GATEWAY_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '::1',
  'dweb.link',
  'ipfs.io',
  'gateway.ipfs.io',
  'cf-ipfs.com',
  'cloudflare-ipfs.com',
  'gateway.pinata.cloud',
  'nftstorage.link',
  'w3s.link',
  '4everland.io',
  'ipfs.fleek.co',
  'dweb.eu.org',
]);

function isKnownGatewayHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const lower = host.toLowerCase();
  if (KNOWN_GATEWAY_HOSTS.has(lower)) return true;
  // *.localhost (Kubo's subdomain-gateway form leaks into the host slot
  // when relative URLs in directory listings are resolved against the
  // page's `ipfs:` origin).
  if (lower.endsWith('.localhost')) return true;
  return false;
}

// Cheap pre-filter for hosts with empty labels (e.g. `.eth`, `foo..eth`).
// Mirrors the bzz handler's hasEmptyLabel — see that file for the rationale
// (don't enforce a minimum label length; legacy two-char `.eth` registrations
// and single-char subdomains are both valid).
function hasEmptyLabel(host) {
  return host.split('.').some((label) => label.length === 0);
}

// Second arg is destructured to `{ pathname, search }` so both the
// non-rewritten path (top-level `ipfs://name.eth/...`) and the rewritten
// path (sub-resource `ipfs://localhost/ipfs/<cid>/...` → effectively
// `ipfs://<cid>/...`) flow in cleanly.
async function resolveEnsToGatewayUrl(namespace, host, parsed, gw) {
  let result;
  try {
    result = await resolveEnsContent(host);
  } catch (err) {
    log.warn(`[${namespace}-protocol] ENS resolver threw for ${host}: ${err.message}`);
    return { ok: false, status: 502, message: `ENS resolver error: ${err.message}` };
  }

  if (!result) {
    return { ok: false, status: 502, message: `ENS resolver returned no result for ${host}` };
  }

  if (result.type === 'ok') {
    if (result.protocol !== namespace) {
      return {
        ok: false,
        status: 404,
        message: `ENS name ${host} resolves to ${result.protocol}, not ${namespace.toUpperCase()}`,
      };
    }
    return {
      ok: true,
      url: `${gw}/${namespace}/${result.decoded}${parsed.pathname}${parsed.search}`,
    };
  }

  if (result.type === 'not_found') {
    return {
      ok: false,
      status: 404,
      message: `ENS name ${host} has no contenthash (${result.reason || 'unknown'})`,
    };
  }

  if (result.type === 'unsupported') {
    return {
      ok: false,
      status: 415,
      message: `ENS name ${host} contenthash format unsupported`,
    };
  }

  if (result.type === 'conflict') {
    return { ok: false, status: 502, message: `ENS providers disagree on ${host}` };
  }

  return {
    ok: false,
    status: 502,
    message: `ENS resolution failed for ${host}: ${result.error || result.reason || 'unknown'}`,
  };
}

function jsonErrorResponse(status, message) {
  return new Response(JSON.stringify({ code: status, message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Core handler, exported for testability. `fetchImpl` defaults to global
 * fetch but tests can inject a stub.
 */
async function handleRequest(namespace, request, { fetchImpl = fetch } = {}) {
  const built = await buildGatewayUrl(namespace, request.url);
  if (!built) {
    return jsonErrorResponse(400, `invalid ${namespace} reference`);
  }
  if (!built.ok) {
    log.info(`[${namespace}-protocol] ${built.status} for ${request.url}: ${built.message}`);
    return jsonErrorResponse(built.status, built.message);
  }

  const headers = sanitizeRequestHeaders(request.headers);
  const method = request.method || 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : request.body;
  // `redirect: 'follow'` is load-bearing here — see the file header. Kubo's
  // localhost path → subdomain redirect must be consumed inside this handler;
  // surfacing it to Chromium would re-introduce the gateway-origin bug.
  const init = { method, headers, signal: request.signal, redirect: 'follow' };
  if (body) {
    init.body = body;
    init.duplex = 'half';
  }

  try {
    return await fetchImpl(built.url, init);
  } catch (err) {
    const code = err?.cause?.code || err?.code || '';
    const isConnRefused =
      code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND';
    log.warn(
      `[${namespace}-protocol] fetch failed for ${built.url}: ${err?.message || err}` +
        (code ? ` (${code})` : '')
    );
    return jsonErrorResponse(
      isConnRefused ? 503 : 502,
      isConnRefused ? 'kubo gateway unreachable' : 'kubo gateway error'
    );
  }
}

/**
 * Build a `register*Protocol(targetSession)` function for the given
 * namespace. Two registrations are exported (ipfs / ipns) so the wire-up
 * in `index.js` mirrors the bzz registration.
 *
 * Call after `app.whenReady()`. Both schemes must already have been
 * registered privileged via `protocol.registerSchemesAsPrivileged` before
 * `app.ready` — see `src/main/index.js`.
 */
function makeRegister(namespace) {
  return function register(targetSession) {
    if (!targetSession?.protocol?.handle) {
      log.warn(`[${namespace}-protocol] session.protocol.handle unavailable — skipping`);
      return;
    }
    try {
      targetSession.protocol.handle(namespace, (request) => handleRequest(namespace, request));
      log.info(`[${namespace}-protocol] handler registered`);
    } catch (err) {
      log.error(`[${namespace}-protocol] failed to register handler:`, err);
    }
  };
}

const registerIpfsProtocol = makeRegister('ipfs');
const registerIpnsProtocol = makeRegister('ipns');

module.exports = {
  registerIpfsProtocol,
  registerIpnsProtocol,
  handleRequest,
  buildGatewayUrl,
  sanitizeRequestHeaders,
};
