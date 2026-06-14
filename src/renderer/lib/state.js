// Shared renderer state
// This module holds state that needs to be accessed across multiple UI modules

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
    ant: {
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

  // Bee/Swarm Gateway config (defaults from env or hardcoded, updated from registry)
  antBase: (window.nodeConfig?.antApi || 'http://127.0.0.1:1633').replace(/\/$/, ''),
  get bzzRoutePrefix() {
    return `${this.antBase}/bzz/`;
  },

  // IPFS Gateway config (defaults from env or hardcoded, updated from registry)
  ipfsBase: (window.nodeConfig?.ipfsGateway || 'http://localhost:8080').replace(/\/$/, ''),
  ipfsApiBase: 'http://127.0.0.1:5001',
  get ipfsRoutePrefix() {
    return `${this.ipfsBase}/ipfs/`;
  },
  get ipnsRoutePrefix() {
    return `${this.ipfsBase}/ipns/`;
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
  antMenuOpen: false,

  // Bee/Swarm state
  currentAntStatus: 'stopped',
  antPeersInterval: null,
  antVisibleInterval: null,
  antVersionFetched: false,
  antVersionValue: '',
  suppressRunningStatus: false,

  // IPFS state
  currentIpfsStatus: 'stopped',
  ipfsInfoInterval: null,
  ipfsVersionFetched: false,
  ipfsVersionValue: '',
  suppressIpfsRunningStatus: false,

  // Radicle state
  currentRadicleStatus: 'stopped',
  radicleInfoInterval: null,
  radicleVersionFetched: false,
  radicleVersionValue: '',
  suppressRadicleRunningStatus: false,

  // Radicle Gateway config (defaults updated from registry)
  radicleBase: 'http://127.0.0.1:8780',
  get radicleApiPrefix() {
    return `${this.radicleBase}/api/v1/repos/`;
  },

  // Navigation state for Radicle
  currentRadBase: null,

  // Feature flags
  enableRadicleIntegration: false,
  blockUnverifiedEns: true, // When true, unverified ENS resolutions route through an interstitial
};

// Build Bee URL using registry or fallback to defaults
export const buildAntUrl = (endpoint) => {
  const base = state.registry.ant.api || state.antBase;
  return `${base}${endpoint}`;
};

// Build IPFS API URL using registry or fallback to defaults
export const buildIpfsApiUrl = (endpoint) => {
  const base = state.registry.ipfs.api || state.ipfsApiBase;
  return `${base}${endpoint}`;
};

// Build Radicle API URL using registry or fallback to defaults
export const buildRadicleUrl = (endpoint) => {
  const base = state.registry.radicle.api || state.radicleBase;
  return `${base}${endpoint}`;
};

// Update registry state from main process
export const updateRegistry = (newRegistry) => {
  state.registry = newRegistry;

  // Update base URLs from registry if available
  if (newRegistry.ant.api) {
    state.antBase = newRegistry.ant.api.replace(/\/$/, '');
  }
  if (newRegistry.ipfs.gateway) {
    state.ipfsBase = newRegistry.ipfs.gateway.replace(/\/$/, '');
  }
  if (newRegistry.ipfs.api) {
    state.ipfsApiBase = newRegistry.ipfs.api.replace(/\/$/, '');
  }
  if (newRegistry.radicle?.api) {
    state.radicleBase = newRegistry.radicle.api.replace(/\/$/, '');
  }
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
