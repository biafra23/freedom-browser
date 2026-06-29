// IPFS node UI controls
import { state, getDisplayMessage } from './state.js';
import { pushDebug } from './debug.js';

// DOM elements (initialized in initIpfsUi)
let ipfsToggleBtn = null;
let ipfsToggleSwitch = null;
let ipfsActiveRequestsCount = null;
let ipfsDataRead = null;
let ipfsVersionText = null;
let ipfsInfoPanel = null;
let ipfsStatusRow = null;
let ipfsStatusLabel = null;
let ipfsStatusValue = null;

// Binary availability state
let ipfsBinaryAvailable = true;

// Guards one-time listener/subscription wiring so re-running initIpfsUi (e.g.
// to re-check binary availability) doesn't bind the click handler twice.
let ipfsListenersAttached = false;

export const stopIpfsInfoPolling = () => {
  if (state.ipfsInfoInterval) {
    clearInterval(state.ipfsInfoInterval);
    state.ipfsInfoInterval = null;
  }
  ipfsInfoPanel?.classList.remove('visible');
  if (ipfsActiveRequestsCount) ipfsActiveRequestsCount.textContent = '0';
  if (ipfsDataRead) ipfsDataRead.textContent = '';
  if (ipfsVersionText)
    ipfsVersionText.textContent = state.ipfsVersionFetched ? state.ipfsVersionValue : '';
};

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const parseNativeBuildInfo = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const formatNativeVersionLabel = (diagnostics = {}) => {
  const buildInfo = parseNativeBuildInfo(diagnostics.nativeBuildInfo);
  const version =
    (typeof buildInfo?.version === 'string' && buildInfo.version) ||
    (typeof diagnostics.nativeVersion === 'string' && diagnostics.nativeVersion) ||
    '';
  return version ? `Freedom IPFS v${version}` : 'Freedom IPFS';
};

// The node counts as running for UI purposes when a pending toggle wants it on,
// or — with no toggle in flight — when the live status says so. Toggle handling
// and stats polling share this so a pending "on" doesn't leave the panel blank
// while the backend is still reporting the stale 'stopped' status.
const isIpfsEffectivelyRunning = () =>
  state.ipfsDesiredRunning !== null
    ? state.ipfsDesiredRunning
    : state.currentIpfsStatus === 'running' || state.currentIpfsStatus === 'starting';

const fetchNativeStats = async () => {
  if (!state.antMenuOpen) return;
  if (!isIpfsEffectivelyRunning()) {
    stopIpfsInfoPolling();
    return;
  }
  if (!ipfsInfoPanel?.classList.contains('visible')) return;

  try {
    const status = await window.ipfs?.getStatus?.();
    if (!ipfsInfoPanel?.classList.contains('visible')) return;
    const stats = JSON.parse(status?.diagnostics?.nativeGatewayStats || '{}');
    if (ipfsActiveRequestsCount) {
      ipfsActiveRequestsCount.textContent = String(stats.active_native_handles ?? 0);
    }
    if (ipfsDataRead) {
      ipfsDataRead.textContent = formatBytes(stats.bytes_read || 0);
    }
  } catch {
    if (ipfsActiveRequestsCount) ipfsActiveRequestsCount.textContent = '0';
    if (ipfsDataRead) ipfsDataRead.textContent = '';
  }
};

const fetchVersionOnce = async () => {
  if (state.ipfsVersionFetched) return;
  state.ipfsVersionFetched = true;
  let versionLabel = null;
  try {
    const status = await window.ipfs?.getStatus?.();
    versionLabel = formatNativeVersionLabel(status?.diagnostics);
  } catch {
    // Fall back below; version display must not block status polling.
  }
  state.ipfsVersionValue = versionLabel || 'Freedom IPFS';
  if (ipfsVersionText) ipfsVersionText.textContent = state.ipfsVersionValue;
};

export const startIpfsInfoPolling = () => {
  if (!state.antMenuOpen || !isIpfsEffectivelyRunning()) {
    stopIpfsInfoPolling();
    return;
  }

  ipfsInfoPanel?.classList.add('visible');

  fetchNativeStats();
  if (!state.ipfsVersionFetched) fetchVersionOnce();

  if (state.ipfsInfoInterval) clearInterval(state.ipfsInfoInterval);
  state.ipfsInfoInterval = setInterval(fetchNativeStats, 1000);
};

export const updateIpfsUi = (status, error) => {
  state.currentIpfsStatus = status;

  // Reconcile a pending user toggle. Once the backend confirms the state the
  // user asked for, the transition is over and the live status drives the switch
  // again. Until then we keep the pending intent so that a rapid on/off/on
  // sequence — which makes the backend emit transient stopping/starting and
  // stale stopped/running states — can't flip the switch out from under the user
  // before the node data settles.
  const reachedDesired =
    (state.ipfsDesiredRunning === true && status === 'running') ||
    (state.ipfsDesiredRunning === false && status === 'stopped');
  // A failed *start* (intent was "on") ends that attempt, so let the switch fall
  // back to the error/live status. A failed *stop* (intent was "off") leaves the
  // node running, so we hold the user's intent rather than letting a later
  // 'running' poll silently flip the switch back on.
  const failedStart = status === 'error' && state.ipfsDesiredRunning === true;
  if (reachedDesired || failedStart) {
    state.ipfsDesiredRunning = null;
  }

  // Update status line and toggle disabled/external state from registry
  updateIpfsStatusLine();
  updateIpfsToggleState();

  if (!ipfsToggleBtn || !ipfsToggleSwitch) return;

  // While a toggle is in flight the switch follows the user's intent; once it
  // settles (ipfsDesiredRunning === null) it follows the live status.
  const showRunning = isIpfsEffectivelyRunning();

  ipfsToggleSwitch.classList.toggle('running', showRunning);

  if (status === 'error') {
    if (error) pushDebug(`IPFS Error: ${error}`);
  } else if (!showRunning && ipfsStatusRow) {
    // Clear the status row once the node is no longer running.
    ipfsStatusRow.classList.remove('visible');
  }

  if (state.antMenuOpen) {
    if (!showRunning) {
      stopIpfsInfoPolling();
    } else if (!state.ipfsInfoInterval) {
      startIpfsInfoPolling();
    }
  }
};

const setToggleDisabled = (disabled) => {
  if (!ipfsToggleBtn) return;

  if (disabled) {
    ipfsToggleBtn.classList.add('disabled');
    ipfsToggleBtn.setAttribute('disabled', 'true');
    ipfsToggleBtn.setAttribute('title', 'IPFS binary not found');
  } else {
    ipfsToggleBtn.classList.remove('disabled');
    ipfsToggleBtn.removeAttribute('disabled');
    ipfsToggleBtn.removeAttribute('title');
  }
};

// Update the status row from registry
export const updateIpfsStatusLine = () => {
  if (!ipfsStatusRow || !ipfsStatusLabel || !ipfsStatusValue) return;

  const message = getDisplayMessage('ipfs');

  if (message && ipfsStatusRow) {
    // Parse "Label: value" format
    const colonIndex = message.indexOf(':');
    if (colonIndex > 0) {
      ipfsStatusLabel.textContent = message.substring(0, colonIndex + 1);
      ipfsStatusValue.textContent = message.substring(colonIndex + 1).trim();
    } else {
      // Fallback for messages without colon
      ipfsStatusLabel.textContent = message;
      ipfsStatusValue.textContent = '';
    }
    ipfsStatusRow.classList.add('visible');
  } else {
    ipfsStatusLabel.textContent = '';
    ipfsStatusValue.textContent = '';
    ipfsStatusRow.classList.remove('visible');
  }
};

// Update toggle disabled state based on node mode
export const updateIpfsToggleState = () => {
  if (!ipfsToggleBtn) return;

  const mode = state.registry?.ipfs?.mode;
  const isReused = mode === 'reused';

  if (isReused) {
    ipfsToggleBtn.classList.add('external');
    ipfsToggleBtn.setAttribute('title', 'Using existing node — cannot be controlled from Freedom');
  } else if (ipfsBinaryAvailable) {
    ipfsToggleBtn.classList.remove('external');
    ipfsToggleBtn.removeAttribute('title');
  }
};

export const initIpfsUi = () => {
  // Initialize DOM elements
  ipfsToggleBtn = document.getElementById('ipfs-toggle-btn');
  ipfsToggleSwitch = document.getElementById('ipfs-toggle-switch');
  ipfsActiveRequestsCount = document.getElementById('ipfs-active-requests-count');
  ipfsDataRead = document.getElementById('ipfs-data-read');
  ipfsVersionText = document.getElementById('ipfs-version-text');
  ipfsInfoPanel = document.querySelector('.ipfs-info');
  ipfsStatusRow = document.getElementById('ipfs-status-row');
  ipfsStatusLabel = document.getElementById('ipfs-status-label');
  ipfsStatusValue = document.getElementById('ipfs-status-value');

  // Check binary availability
  if (window.ipfs) {
    window.ipfs.checkBinary().then(({ available }) => {
      ipfsBinaryAvailable = available;
      setToggleDisabled(!available);
      if (!available) {
        pushDebug('IPFS binary not found - toggle disabled');
      }
    });
  }

  if (ipfsListenersAttached) return;
  ipfsListenersAttached = true;

  // Toggle button listener
  ipfsToggleBtn?.addEventListener('click', () => {
    if (!ipfsBinaryAvailable) return;

    // Don't allow toggling when using an external node
    const mode = state.registry?.ipfs?.mode;
    if (mode === 'reused') return;

    // Base the decision on a pending toggle if one is in flight, otherwise on
    // the live status — so a quick second click reverses the user's last intent
    // rather than reacting to a transient stopping/starting state.
    const currentlyOn = isIpfsEffectivelyRunning();

    if (currentlyOn) {
      state.ipfsDesiredRunning = false;
      ipfsToggleSwitch?.classList.remove('running');
      stopIpfsInfoPolling();
      pushDebug('User toggled IPFS Off');
      window.ipfs
        .stop()
        .then(({ status, error }) => updateIpfsUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle IPFS', err);
          pushDebug(`Failed to toggle IPFS: ${err.message}`);
        });
    } else {
      state.ipfsDesiredRunning = true;
      ipfsToggleSwitch?.classList.add('running');
      startIpfsInfoPolling();
      pushDebug('User toggled IPFS On');
      window.ipfs
        .start()
        .then(({ status, error }) => updateIpfsUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle IPFS', err);
          pushDebug(`Failed to toggle IPFS: ${err.message}`);
        });
    }
  });

  // Listen for status updates from main process
  if (window.ipfs) {
    const handleStatus = ({ status, error }) => {
      pushDebug(`IPFS Status Update: ${status} ${error ? `(${error})` : ''}`);
      updateIpfsUi(status, error);
    };
    window.ipfs.onStatusUpdate(handleStatus);

    // Initial status check
    const refreshIpfsStatus = () => {
      window.ipfs.getStatus().then(({ status, error }) => {
        updateIpfsUi(status, error);
      });
    };
    refreshIpfsStatus();
    setInterval(refreshIpfsStatus, 5000);
  }
};
