import { applyEnsNamePreservation, deriveDisplayValue } from './url-utils.js';
import { getInternalPageName, parseEnsInput } from './page-urls.js';
import { isEnsHost } from './origin-utils.js';

// Extract the ENS name from an address bar value, or null if the value isn't
// an ENS resolution input. Thin wrapper around `parseEnsInput` so the
// render-loop helpers (protocol icon, trust shield) share the single
// parsing implementation in `page-urls.js`.
const extractEnsName = (normalizedValue) => parseEnsInput(normalizedValue)?.name ?? null;

// Trust-shield state for the address bar. Returns `null` to hide the shield
// (non-ENS URLs, or ENS name we haven't resolved this session). Otherwise
// returns `{ level, name, trust }` so the shield can render and the popover
// can fill in details.
export const resolveTrustBadge = ({ value = '', ensTrustByName = new Map() } = {}) => {
  const normalizedValue = value.toLowerCase();
  const ensName = extractEnsName(normalizedValue);
  if (!ensName) return null;
  const trust = ensTrustByName.get(ensName);
  if (!trust || !trust.level) return null;
  return { level: trust.level, name: ensName, trust };
};

// One-sentence status shown at the top of the trust popover, below the ENS
// name. Keyed on trust level (and, for verified, on the resolution method).
// Lookup misses (unknown level) yield `null` from `buildTrustRows({...}).status`
// and the caller decides how to handle. Exported because the wallet review
// surface reuses these as tooltip copy — keep the vocabulary in one place.
export const TRUST_STATUS_SENTENCE = {
  verified: 'ENS resolution verified',
  'verified-colibri': 'Cryptographically verified via Colibri',
  'user-configured': 'Resolved with your configured RPC',
  unverified: 'ENS resolution not verified',
  conflict: 'Verification failed: RPCs disagree',
};

// Friendly names for the network row, keyed by the URI's protocol scheme
// (the `bzz` / `ipfs` / `ipns` prefix from the resolved contenthash URI).
// Anything not in the table is shown uppercased.
const TRUST_NETWORK_NAME = {
  ipfs: 'IPFS',
  bzz: 'Swarm',
};

// Hash-row label, keyed by URI scheme. "CID" is IPFS-specific; others
// fall through to the more generic "Content Hash" so the row still
// describes the underlying reference accurately.
const TRUST_HASH_LABEL = {
  ipfs: 'CID',
  bzz: 'Hash',
};

// `state.ensProtocols` stores the resolver's friendly names (`'swarm'`,
// `'ipfs'`, `'ipns'`) while URI schemes use `'bzz'` / `'ipfs'` / `'ipns'`.
// Normalize so both paths feed the lookup tables with the same key. This
// only matters when the URI itself is missing — the URI-parse path
// already produces `'bzz'` directly.
const protoToScheme = (proto) => (proto === 'swarm' ? 'bzz' : proto);

// Network + hash content rows are the same across every resolution method —
// they describe the resolved URI, not how we verified it. Extracted so the
// Colibri branch (which skips the per-method trust rows above) and the
// legacy branch share the rendering shape.
const buildContentRows = ({ uri = '', proto = '' } = {}) => {
  const uriMatch = uri.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/i);
  const scheme = uriMatch
    ? uriMatch[1].toLowerCase()
    : protoToScheme((proto || '').toLowerCase());
  const body = uriMatch ? uriMatch[2] : '';

  const networkName = scheme
    ? TRUST_NETWORK_NAME[scheme] || scheme.toUpperCase()
    : '';
  const hashLabel = TRUST_HASH_LABEL[scheme] || 'Content Hash';

  const contentRows = [];
  if (networkName) {
    contentRows.push({ label: 'Network', display: networkName, copy: '' });
  }
  if (body) {
    contentRows.push({
      label: hashLabel,
      display: body,
      copy: body,
      autoFit: body,
    });
  }
  return contentRows;
};

// Pure helper that turns a `(trust, level, uri, proto)` tuple into the
// data the popover renders: a status sentence and two ordered arrays of
// row descriptors for the trust and content sections. Each row is
// `{ label, display, copy, autoFit? }` — `copy` is the empty string for
// non-clickable summary rows, `autoFit` carries the value to feed
// `fitFieldValueToWidth` for middle-truncation. The DOM build step in
// navigation.js consumes these arrays without re-deriving anything.
export const buildTrustRows = ({
  trust = {},
  level = '',
  uri = '',
  proto = '',
} = {}) => {
  const method = trust.method;
  const isColibri = level === 'verified' && method === 'colibri';
  const statusKey = isColibri ? 'verified-colibri' : level;
  const status = TRUST_STATUS_SENTENCE[statusKey] || null;

  const agreed = Array.isArray(trust.agreed) ? trust.agreed : [];
  const queried = Array.isArray(trust.queried) ? trust.queried : [];
  const dissented = Array.isArray(trust.dissented) ? trust.dissented : [];
  const blockNumber = trust.block?.number;

  const trustRows = [];

  // Colibri results carry single-source agreed/queried (the prover host) by
  // design — the cryptographic verification *replaces* the M-of-K heuristic,
  // it doesn't run alongside it. Surface the prover + method instead of the
  // degenerate quorum row.
  if (isColibri) {
    if (trust.prover) {
      trustRows.push({
        label: 'Verified by',
        display: trust.prover,
        copy: trust.prover,
        autoFit: trust.prover,
      });
    }
    return { status, trustRows, contentRows: buildContentRows({ uri, proto }) };
  }

  // Quorum summary is meaningful only when more than one RPC was queried;
  // otherwise "1 of 1" is degenerate and just adds noise on the
  // user-configured / unverified rows.
  if (queried.length > 1) {
    trustRows.push({
      label: 'RPC Quorum',
      display: `${agreed.length}/${queried.length}`,
      copy: '',
    });
  }

  if (level === 'user-configured' && agreed.length > 0) {
    // For user-configured the single RPC is the user's own choice, so
    // we label it "Your RPC:" rather than "RPC 1:" — it conveys why
    // there's only one and that no quorum check ran.
    trustRows.push({
      label: 'Your RPC',
      display: agreed[0],
      copy: agreed[0],
      autoFit: agreed[0],
    });
  } else {
    agreed.forEach((host, idx) => {
      trustRows.push({
        label: `RPC ${idx + 1}`,
        display: host,
        copy: host,
        autoFit: host,
      });
    });
  }

  // Dissenting RPCs only appear in conflict cases. Number them when
  // there's more than one so they don't all read identically.
  if (dissented.length === 1) {
    trustRows.push({
      label: 'Dissenting RPC',
      display: dissented[0],
      copy: dissented[0],
      autoFit: dissented[0],
    });
  } else {
    dissented.forEach((host, idx) => {
      trustRows.push({
        label: `Dissenting RPC ${idx + 1}`,
        display: host,
        copy: host,
        autoFit: host,
      });
    });
  }

  if (blockNumber !== undefined && blockNumber !== null && blockNumber !== '') {
    const num = String(blockNumber);
    trustRows.push({ label: 'Block', display: num, copy: num });
  }

  return { status, trustRows, contentRows: buildContentRows({ uri, proto }) };
};

export const resolveProtocolIconType = ({
  value = '',
  ensProtocols = new Map(),
  enableRadicleIntegration = false,
  currentPageSecure = false,
} = {}) => {
  const normalizedValue = value.toLowerCase();

  // Transport scheme wins first: the URL itself tells us what protocol the
  // page uses, regardless of whether the host happens to be an ENS name. This
  // matters for the post-resolution display forms (`bzz://name.eth`,
  // `ipfs://name.eth`, `ipns://name.eth`) — the protocol icon should match
  // the transport even before we've cached an `ensProtocols` entry.
  if (normalizedValue.startsWith('bzz://')) return 'swarm';
  if (normalizedValue.startsWith('ipfs://')) return 'ipfs';
  if (normalizedValue.startsWith('ipns://')) return 'ipns';
  if (normalizedValue.startsWith('rad://')) {
    return enableRadicleIntegration ? 'radicle' : 'http';
  }
  // Internal pages aren't network-served, but we still surface the
  // neutral globe (same icon `rad://` falls back to when its integration
  // is disabled) so the address bar always carries some leading mark
  // and never reuses the trust shield from a previous ENS page.
  if (normalizedValue.startsWith('freedom://')) return 'http';

  // Bare ENS / legacy `ens://` falls back to the cached resolved protocol.
  const ensName = extractEnsName(normalizedValue);
  if (ensName) {
    return ensProtocols.get(ensName) || 'http';
  }

  if (normalizedValue.startsWith('https://') || currentPageSecure) {
    return 'https';
  }

  return 'http';
};

export const buildRadicleDisabledUrl = (baseHref, inputValue = '') => {
  const errorUrl = new URL('pages/rad-browser.html', baseHref);
  errorUrl.searchParams.set('error', 'disabled');
  if (inputValue) {
    errorUrl.searchParams.set('input', inputValue);
  }
  return errorUrl.toString();
};

export const getRadicleDisplayUrl = (url) => {
  if (!url || !url.includes('rad-browser.html')) return null;
  try {
    const parsed = new URL(url);
    const rid = parsed.searchParams.get('rid');
    const path = parsed.searchParams.get('path') || '';
    if (rid) {
      return `rad://${rid}${path}`;
    }
  } catch {
    // Ignore parse errors.
  }
  return null;
};

export const applyEnsSuffix = (targetUri, suffix = '') => {
  if (!suffix) {
    return targetUri;
  }

  try {
    return new URL(suffix, targetUri).toString();
  } catch {
    return `${targetUri.replace(/\/+$/, '')}${suffix}`;
  }
};

export const extractEnsResolutionMetadata = (targetUri, ensName) => {
  const knownEnsPairs = [];
  let resolvedProtocol = null;

  const bzzMatch = targetUri.match(/^bzz:\/\/([a-fA-F0-9]+)/);
  if (bzzMatch) {
    knownEnsPairs.push([bzzMatch[1].toLowerCase(), ensName]);
    resolvedProtocol = 'swarm';
  }

  const ipfsMatch = targetUri.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
  if (ipfsMatch) {
    knownEnsPairs.push([ipfsMatch[1], ensName]);
    resolvedProtocol = 'ipfs';
  }

  const ipnsMatch = targetUri.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
  if (ipnsMatch) {
    knownEnsPairs.push([ipnsMatch[1], ensName]);
    // Track IPNS distinctly from IPFS so the protocol icon and transport
    // display reflect the actual contenthash transport (an IPNS-backed
    // ENS name was being mis-displayed as `ipfs://name.eth` otherwise).
    resolvedProtocol = 'ipns';
  }

  return {
    knownEnsPairs,
    resolvedProtocol,
  };
};

export const deriveDisplayAddress = ({
  url = '',
  bzzRoutePrefix,
  homeUrlNormalized,
  ipfsRoutePrefix = null,
  ipnsRoutePrefix = null,
  radicleApiPrefix = null,
  knownEnsNames = new Map(),
} = {}) => {
  const display = deriveDisplayValue(
    url,
    bzzRoutePrefix,
    homeUrlNormalized,
    ipfsRoutePrefix,
    ipnsRoutePrefix,
    radicleApiPrefix
  );

  return applyEnsNamePreservation(display, knownEnsNames);
};

// ENS-host transport URLs (`bzz://name.eth/...`, `ipfs://name.eth/...`,
// `ipns://name.eth/...`) cannot be turned into a gateway path here — the
// host has to be resolved to a CID/hash first via the ENS resolver. The
// caller (`loadTarget` view-source branch) handles that and passes the
// already-resolved transport URI back through this function, so we only
// need to skip ENS hosts in the strict "host is hex/CID/IPNS-id" branches
// below.

export const buildViewSourceNavigation = ({
  value = '',
  bzzRoutePrefix,
  homeUrlNormalized,
  ipfsRoutePrefix = null,
  ipnsRoutePrefix = null,
  radicleApiPrefix = null,
  knownEnsNames = new Map(),
} = {}) => {
  const innerUrl = value.startsWith('view-source:') ? value.slice(12) : value;

  const bzzMatch = innerUrl.match(/^bzz:\/\/([a-fA-F0-9]+)(\/.*)?$/);
  if (bzzMatch && !isEnsHost(bzzMatch[1])) {
    const hash = bzzMatch[1];
    const path = bzzMatch[2] || '/';
    return {
      addressValue: value,
      loadUrl: `view-source:${bzzRoutePrefix}${hash}${path}`,
    };
  }

  const ipfsMatch = innerUrl.match(/^ipfs:\/\/([A-Za-z0-9]+)(\/.*)?$/);
  if (ipfsMatch && !isEnsHost(ipfsMatch[1])) {
    const cid = ipfsMatch[1];
    const path = ipfsMatch[2] || '';
    return {
      addressValue: value,
      loadUrl: `view-source:${ipfsRoutePrefix}${cid}${path}`,
    };
  }

  const ipnsMatch = innerUrl.match(/^ipns:\/\/([A-Za-z0-9.-]+)(\/.*)?$/);
  if (ipnsMatch && !isEnsHost(ipnsMatch[1])) {
    const name = ipnsMatch[1];
    const path = ipnsMatch[2] || '';
    return {
      addressValue: value,
      loadUrl: `view-source:${ipnsRoutePrefix}${name}${path}`,
    };
  }

  const displayInner = deriveDisplayAddress({
    url: innerUrl,
    bzzRoutePrefix,
    homeUrlNormalized,
    ipfsRoutePrefix,
    ipnsRoutePrefix,
    radicleApiPrefix,
    knownEnsNames,
  });

  return {
    addressValue: `view-source:${displayInner || innerUrl}`,
    loadUrl: value,
  };
};

export const deriveSwitchedTabDisplay = ({
  url = '',
  isLoading = false,
  addressBarSnapshot = '',
  isViewingSource = false,
  bzzRoutePrefix,
  homeUrlNormalized,
  ipfsRoutePrefix = null,
  ipnsRoutePrefix = null,
  radicleApiPrefix = null,
  knownEnsNames = new Map(),
} = {}) => {
  if (isLoading && addressBarSnapshot) {
    return addressBarSnapshot;
  }

  const urlToDerive = url.startsWith('view-source:') ? url.slice(12) : url;
  const internalPageName = getInternalPageName(urlToDerive);
  if (internalPageName && internalPageName !== 'home') {
    return `freedom://${internalPageName}`;
  }

  let display = deriveDisplayAddress({
    url: urlToDerive,
    bzzRoutePrefix,
    homeUrlNormalized,
    ipfsRoutePrefix,
    ipnsRoutePrefix,
    radicleApiPrefix,
    knownEnsNames,
  });

  if (display === homeUrlNormalized) {
    display = '';
  }

  if (isViewingSource && display) {
    return `view-source:${display}`;
  }

  return display;
};

export const getBookmarkBarState = ({
  url = '',
  bookmarkBarOverride = false,
  homeUrl = '',
  homeUrlNormalized = '',
} = {}) => {
  const isHomePage = url === homeUrlNormalized || url === homeUrl || !url;

  return {
    isHomePage,
    visible: isHomePage || bookmarkBarOverride,
  };
};

export const getOriginalUrlFromErrorPage = (url, errorUrlBase = '') => {
  if (!url) {
    return null;
  }

  const isErrorPage =
    (errorUrlBase && url.startsWith(errorUrlBase)) || url.includes('/error.html?');
  if (!isErrorPage) {
    return null;
  }

  try {
    return new URL(url).searchParams.get('url');
  } catch {
    return null;
  }
};
