// Shared renderer state
// This module holds state that needs to be accessed across multiple UI modules

const normalizeBaseUrl = (value) =>
  typeof value === 'string' && value ? value.replace(/\/$/, '') : null;

const envBeeApi = normalizeBaseUrl(window.nodeConfig?.beeApi);
const envIpfsGateway = normalizeBaseUrl(window.nodeConfig?.ipfsGateway);

export const state = {
  // Service Registry (updated from main process)
  registry: {
    ipfs: {
      api: null,
      gateway: null,
      mode: 'none',
      statusMessage: null,
      tempMessage: null,
    },
    bee: {
      api: null,
      gateway: null,
      mode: 'none',
      statusMessage: null,
      tempMessage: null,
    },
    radicle: {
      api: null,
      gateway: null,
      mode: 'none',
      statusMessage: null,
      tempMessage: null,
    },
  },

  // Bee/Swarm Gateway config (from env override or registry)
  beeBase: envBeeApi,
  get bzzRoutePrefix() {
    return this.beeBase ? `${this.beeBase}/bzz/` : null;
  },

  // IPFS Gateway config (from env override or registry)
  ipfsBase: envIpfsGateway,
  ipfsApiBase: null,
  get ipfsRoutePrefix() {
    return this.ipfsBase ? `${this.ipfsBase}/ipfs/` : null;
  },
  get ipnsRoutePrefix() {
    return this.ipfsBase ? `${this.ipfsBase}/ipns/` : null;
  },

  // Navigation state
  currentPageUrl: '',
  pendingNavigationUrl: '',
  pendingTitleForUrl: null,
  hasNavigatedDuringCurrentLoad: false,
  isWebviewLoading: false,
  currentBzzBase: null,
  knownEnsNames: new Map(), // Maps hash/CID -> ENS name
  ensProtocols: new Map(), // Maps ENS name -> resolved protocol (swarm/ipfs/ipns)
  ensTrustByName: new Map(), // Maps ENS name -> trust object from last resolution
  ensUriByName: new Map(), // Maps ENS name -> full resolved content URI (bzz://HASH, ipfs://CID, ipns://NAME)
  // Transient draft/restoration state — overwritten with the live address
  // bar value on focusin and tab-switched. Do not key reload or other
  // commit-sensitive decisions on this field; use `committedDisplayUrl`.
  addressBarSnapshot: '',
  // URL of the last committed navigation (`webview.getURL()` at
  // did-navigate time). Written only by tabs.js' per-webview did-navigate
  // handler, so it stays stable when the user is mid-typing or while a
  // navigation is still in flight. Used by reload and by
  // `getDisplayUrlForWebview` for provider permission keying.
  committedDisplayUrl: '',

  // Webview
  cachedWebContentsId: null,
  resolvingWebContentsId: null,

  // UI state
  menuOpen: false,
  beeMenuOpen: false,

  // Bee/Swarm state
  currentBeeStatus: 'stopped',
  beePeersInterval: null,
  beeVisibleInterval: null,
  beeVersionFetched: false,
  beeVersionValue: '',
  suppressRunningStatus: false,

  // IPFS state
  currentIpfsStatus: 'stopped',
  ipfsPeersInterval: null,
  ipfsVersionFetched: false,
  ipfsVersionValue: '',
  suppressIpfsRunningStatus: false,

  // Radicle state
  currentRadicleStatus: 'stopped',
  radicleInfoInterval: null,
  radicleVersionFetched: false,
  radicleVersionValue: '',
  suppressRadicleRunningStatus: false,

  // Radicle Gateway config (updated from registry)
  radicleBase: null,
  get radicleApiPrefix() {
    return this.radicleBase ? `${this.radicleBase}/api/v1/repos/` : null;
  },

  // Navigation state for Radicle
  currentRadBase: null,

  // Feature flags
  enableRadicleIntegration: false,
  blockUnverifiedEns: true, // When true, unverified ENS resolutions route through an interstitial
};

const buildServiceUrl = (base, endpoint, serviceName) => {
  if (!base) {
    throw new Error(`${serviceName} endpoint is not ready`);
  }
  return `${base}${endpoint}`;
};

// Build Bee URL using registry or explicit env override
export const buildBeeUrl = (endpoint) => {
  const base = state.registry.bee.api || state.beeBase;
  return buildServiceUrl(base, endpoint, 'Bee');
};

// Build IPFS API URL using registry
export const buildIpfsApiUrl = (endpoint) => {
  const base = state.registry.ipfs.api || state.ipfsApiBase;
  return buildServiceUrl(base, endpoint, 'IPFS API');
};

// Build Radicle API URL using registry
export const buildRadicleUrl = (endpoint) => {
  const base = state.registry.radicle.api || state.radicleBase;
  return buildServiceUrl(base, endpoint, 'Radicle');
};

// Update registry state from main process
export const updateRegistry = (newRegistry) => {
  state.registry = newRegistry;

  state.beeBase = normalizeBaseUrl(newRegistry.bee?.api) || envBeeApi;
  state.ipfsBase = normalizeBaseUrl(newRegistry.ipfs?.gateway) || envIpfsGateway;
  state.ipfsApiBase = normalizeBaseUrl(newRegistry.ipfs?.api);
  state.radicleBase = normalizeBaseUrl(newRegistry.radicle?.api);
};

export const setRadicleIntegrationEnabled = (enabled) => {
  state.enableRadicleIntegration = enabled === true;
};

export const setBlockUnverifiedEns = (enabled) => {
  state.blockUnverifiedEns = enabled !== false;
};

// Get display message for a service (temp message takes priority)
export const getDisplayMessage = (service) => {
  const svc = state.registry[service];
  if (!svc) return null;
  return svc.tempMessage || svc.statusMessage;
};
