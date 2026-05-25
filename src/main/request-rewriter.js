const log = require('./logger');
const { activeBzzBases, activeRadBases } = require('./state');
const { getRadicleApiUrl } = require('./service-registry');
const { loadSettings } = require('./settings-store');
const { URL } = require('url');

const sanitizeUrlForLog = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') return 'unknown';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'file:') {
      return 'file://<redacted>';
    }
    if (
      parsed.protocol === 'bzz:' ||
      parsed.protocol === 'ipfs:' ||
      parsed.protocol === 'ipns:' ||
      parsed.protocol === 'freedom:'
    ) {
      return `${parsed.protocol}//<redacted>`;
    }
    return parsed.origin;
  } catch {
    if (
      rawUrl.startsWith('bzz://') ||
      rawUrl.startsWith('ipfs://') ||
      rawUrl.startsWith('ipns://') ||
      rawUrl.startsWith('freedom://')
    ) {
      return `${rawUrl.split('://')[0]}://<redacted>`;
    }
    return 'unknown';
  }
};

/**
 * Convert a custom protocol URL to a gateway URL.
 * Uses service registry for dynamic port resolution.
 * @param {string} url - The URL to check/convert
 * @returns {{ converted: boolean, url: string }} Result with converted flag and URL
 */
function convertProtocolUrl(url) {
  if (!url) {
    return { converted: false, url };
  }

  // Note: `bzz://`, `ipfs://`, and `ipns://` are handled by custom
  // protocol handlers in `src/main/swarm/bzz-protocol.js` and
  // `src/main/ipfs/ipfs-protocol.js`; see README "Swarm Content Retrieval"
  // and "IPFS / IPNS Content Retrieval". Requests for these schemes never
  // reach the webRequest rewriter — they're dispatched to the protocol
  // handlers before webRequest sees them.

  // Handle rad: and rad:// protocols
  // rad:RID or rad://RID -> <radicle-api>/api/v1/repos/RID
  // rad:RID/tree/branch/path -> <radicle-api>/api/v1/repos/RID/tree/branch/path
  if (url.startsWith('rad:')) {
    if (loadSettings().enableRadicleIntegration !== true) {
      return { converted: false, url };
    }
    // Handle both rad:RID and rad://RID formats
    const remainder = url.startsWith('rad://') ? url.slice(6) : url.slice(4);
    const radicleApiUrl = getRadicleApiUrl();
    if (!radicleApiUrl) {
      log.warn('[rewrite] Radicle endpoint is not ready');
      return { converted: false, url };
    }
    // Parse the remainder to extract RID and optional path
    const slashIndex = remainder.indexOf('/');
    const rid = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
    const pathPart = slashIndex === -1 ? '' : remainder.slice(slashIndex);

    // Validate RID: must start with z followed by base58 characters
    if (!/^z[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(rid)) {
      log.warn(`[rewrite] Blocked invalid Radicle RID: ${rid}`);
      return { converted: false, url };
    }

    const gatewayUrl = `${radicleApiUrl}/api/v1/repos/${rid}${pathPart}`;
    return { converted: true, url: gatewayUrl };
  }

  return { converted: false, url };
}

/**
 * Determines if a request should be rewritten to stay within a content-addressed context.
 * @param {string} requestUrl - The URL being requested
 * @param {string} baseUrl - The current base URL (bzz or ipfs)
 * @param {string} type - 'bzz' or 'ipfs'
 * @returns {{ shouldRewrite: boolean, reason?: string }} Result with reason if not rewriting
 */
function shouldRewriteRequest(requestUrl, baseUrl) {
  if (!baseUrl) {
    return { shouldRewrite: false, reason: 'no_base_url' };
  }

  let requested;
  let base;
  try {
    requested = new URL(requestUrl);
    base = new URL(baseUrl);
  } catch {
    return { shouldRewrite: false, reason: 'invalid_url' };
  }

  const normalizedPath = requested.pathname.toLowerCase();

  // Don't rewrite requests that are already content-addressed paths
  if (normalizedPath.startsWith('/bzz/')) {
    return { shouldRewrite: false, reason: 'already_bzz_path' };
  }
  if (normalizedPath.startsWith('/ipfs/') || normalizedPath.startsWith('/ipns/')) {
    return { shouldRewrite: false, reason: 'already_ipfs_path' };
  }
  if (normalizedPath.startsWith('/api/v1/repos/')) {
    return { shouldRewrite: false, reason: 'already_rad_path' };
  }

  // Don't rewrite cross-origin requests
  if (requested.origin !== base.origin) {
    return { shouldRewrite: false, reason: 'cross_origin' };
  }

  return { shouldRewrite: true };
}

/**
 * Builds the rewritten URL for a request that should stay within the Swarm hash context.
 * @param {string} requestUrl - The URL being requested
 * @param {string} baseUrl - The current bzz base URL (e.g., <bee-api>/bzz/hash/)
 * @returns {string|null} The rewritten URL, or null if URLs are invalid
 */
function buildRewriteTarget(requestUrl, baseUrl) {
  let requested;
  let base;
  try {
    requested = new URL(requestUrl);
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  const relativePath = requested.pathname.replace(/^\//, '');
  return `${base.href}${relativePath}${requested.search}${requested.hash}`;
}

/**
 * Check if a URL targets the Bee API's /bzz/ endpoint with an invalid hash.
 * Blocks requests that would cause "bzz download: invalid path" errors on the Bee node.
 * @param {string} url - The final URL about to be sent
 * @returns {boolean} True if the request should be blocked
 */
function shouldBlockInvalidBzzRequest(url) {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 1 && pathParts[0] === 'bzz') {
      // /bzz/ with no hash or an invalid hash
      const hash = pathParts[1] || '';
      if (!hash || !/^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/.test(hash)) {
        return true;
      }
    }
  } catch {
    // Not a valid URL, let it through (will fail naturally)
  }
  return false;
}

function registerRequestRewriter(targetSession) {
  if (!targetSession) {
    return;
  }

  targetSession.webRequest.onBeforeRequest((details, callback) => {
    const webContentsId = details.webContentsId;

    const { converted, url: convertedUrl } = convertProtocolUrl(details.url);
    if (converted) {
      log.info(
        `[rewrite:protocol] ${sanitizeUrlForLog(details.url)} -> ${sanitizeUrlForLog(convertedUrl)}`
      );
      callback({ redirectURL: convertedUrl });
      return;
    }

    // Check for Swarm (bzz) base first
    const bzzBaseUrl = activeBzzBases.get(webContentsId);
    if (bzzBaseUrl) {
      const { shouldRewrite } = shouldRewriteRequest(details.url, bzzBaseUrl);
      if (shouldRewrite) {
        const redirectTarget = buildRewriteTarget(details.url, bzzBaseUrl);
        if (redirectTarget) {
          log.info(
            `[rewrite:bzz] ${sanitizeUrlForLog(details.url)} -> ${sanitizeUrlForLog(redirectTarget)}`
          );
          callback({ redirectURL: redirectTarget });
          return;
        }
      }
    }

    // No IPFS rewriter arm — `ipfs://` and `ipns://` are standard schemes
    // dispatched to `src/main/ipfs/ipfs-protocol.js`, so the page origin is
    // `ipfs://<cid|name>/` and same-origin sub-resources never reach
    // webRequest as gateway URLs.

    // Check for Radicle base
    const radBaseUrl = activeRadBases.get(webContentsId);
    if (radBaseUrl && loadSettings().enableRadicleIntegration === true) {
      const { shouldRewrite } = shouldRewriteRequest(details.url, radBaseUrl);
      if (shouldRewrite) {
        const redirectTarget = buildRewriteTarget(details.url, radBaseUrl);
        if (redirectTarget) {
          log.info(
            `[rewrite:rad] ${sanitizeUrlForLog(details.url)} -> ${sanitizeUrlForLog(redirectTarget)}`
          );
          callback({ redirectURL: redirectTarget });
          return;
        }
      }
    }

    // Final guard: block requests to /bzz/ with missing or invalid hash
    // to prevent "bzz download: invalid path" errors on the Bee node
    if (shouldBlockInvalidBzzRequest(details.url)) {
      callback({ cancel: true });
      return;
    }

    // No rewrite needed
    callback({});
  });
}

module.exports = {
  registerRequestRewriter,
  shouldRewriteRequest,
  buildRewriteTarget,
  convertProtocolUrl,
  shouldBlockInvalidBzzRequest,
  sanitizeUrlForLog,
};
