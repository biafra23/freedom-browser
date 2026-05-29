const log = require('./logger');
const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../shared/ipc-channels');
const {
  MODE,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');
const { FreedomIpfsNativeNode } = require('./ipfs/freedom-ipfs-native-node');

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let activeNode = null;
let healthCheckInterval = null;
let pendingStart = false;

function getIpfsDataPath() {
  if (process.env.FREEDOM_IPFS_DATA) {
    const overrideDir = process.env.FREEDOM_IPFS_DATA;
    fs.mkdirSync(overrideDir, { recursive: true });
    return overrideDir;
  }

  if (!app.isPackaged) {
    const devDataDir = path.join(__dirname, '..', '..', 'ipfs-data');
    fs.mkdirSync(devDataDir, { recursive: true });
    return devDataDir;
  }

  const dataDir = path.join(app.getPath('userData'), 'ipfs-data');
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.IPFS_STATUS_UPDATE, { status: currentState, error: lastError });
  }
}

function checkHealth() {
  return Boolean(activeNode && currentState === STATUS.RUNNING);
}

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(() => {
    const isHealthy = checkHealth();
    if (!isHealthy && currentState === STATUS.RUNNING) {
      updateState(STATUS.ERROR, 'Native node unavailable');
      setErrorState('ipfs', 'Node unavailable. Restart IPFS from the nodes menu.');
    } else if (isHealthy && currentState === STATUS.ERROR) {
      clearErrorState('ipfs');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

function checkBinary() {
  return FreedomIpfsNativeNode.isAvailable();
}

async function startIpfs() {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[IPFS] Ignoring start request, current state: ${currentState}`);
    return;
  }

  if (currentState === STATUS.STOPPING) {
    log.info('[IPFS] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  pendingStart = false;
  updateState(STATUS.STARTING);

  if (!checkBinary()) {
    updateState(STATUS.ERROR, 'freedom-ipfs native addon not built');
    setStatusMessage('ipfs', 'Native node unavailable');
    return;
  }

  const dataDir = getIpfsDataPath();
  const node = new FreedomIpfsNativeNode({ dataDir });

  try {
    if (!node.start()) {
      updateState(STATUS.ERROR, 'Failed to start freedom-ipfs native node');
      setStatusMessage('ipfs', 'Node failed to start');
      return;
    }
  } catch (err) {
    log.error('[IPFS] Failed to start freedom-ipfs native node:', err);
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ipfs', 'Node failed to start');
    return;
  }

  activeNode = node;
  updateService('ipfs', {
    api: null,
    gateway: null,
    mode: MODE.BUNDLED,
    backend: 'freedom-ipfs',
  });
  setStatusMessage('ipfs', 'Node: freedom-ipfs');
  updateState(STATUS.RUNNING);
  startHealthCheck();
  log.info(`[IPFS] freedom-ipfs native node started at ${dataDir}`);
}

async function stopIpfs() {
  pendingStart = false;
  updateState(STATUS.STOPPING);
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }

  const node = activeNode;
  activeNode = null;
  if (node) {
    try {
      await node.stop();
    } catch (err) {
      log.warn('[IPFS] Error while stopping freedom-ipfs native node:', err.message);
    }
  }

  updateState(STATUS.STOPPED);
  clearService('ipfs');

  if (pendingStart) {
    pendingStart = false;
    setTimeout(() => startIpfs(), 100);
  }
}

async function serveNativeGatewayRequest({ path: gatewayPath, method, headers, signal }) {
  if (!activeNode || currentState !== STATUS.RUNNING) {
    return new Response(
      JSON.stringify({ code: 503, message: 'freedom-ipfs node is not running' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }
  return activeNode.request({ method, path: gatewayPath, headers, signal });
}

function getNativeDiagnostics() {
  if (!activeNode) return { progress: '{"active":[],"events":[]}', nativeGatewayStats: '{}' };
  return {
    progress: activeNode.progressSnapshotJson(),
    nativeGatewayStats: activeNode.nativeGatewayStatsJson(),
  };
}

function setUseInjectedIdentity(enabled) {
  log.info(`[IPFS] Ignoring injected identity mode for freedom-ipfs native node: ${enabled}`);
}

function hasInjectedIdentity() {
  return false;
}

function getActivePort() {
  return null;
}

function getActiveGatewayPort() {
  return null;
}

function registerIpfsIpc() {
  ipcMain.handle(IPC.IPFS_START, () => {
    startIpfs();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.IPFS_STOP, () => {
    stopIpfs();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.IPFS_GET_STATUS, () => {
    return { status: currentState, error: lastError, diagnostics: getNativeDiagnostics() };
  });

  ipcMain.handle(IPC.IPFS_CHECK_BINARY, () => {
    return { available: checkBinary() };
  });
}

module.exports = {
  registerIpfsIpc,
  startIpfs,
  stopIpfs,
  getActivePort,
  getActiveGatewayPort,
  getIpfsDataPath,
  setUseInjectedIdentity,
  hasInjectedIdentity,
  serveNativeGatewayRequest,
  getNativeDiagnostics,
  STATUS,
};
