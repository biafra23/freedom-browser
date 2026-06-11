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
    const overrideDir = path.join(process.env.FREEDOM_IPFS_DATA, 'freedom-ipfs');
    fs.mkdirSync(overrideDir, { recursive: true });
    return overrideDir;
  }

  if (!app.isPackaged) {
    const devDataDir = path.join(__dirname, '..', '..', 'ipfs-data', 'freedom-ipfs');
    fs.mkdirSync(devDataDir, { recursive: true });
    return devDataDir;
  }

  const dataDir = path.join(app.getPath('userData'), 'ipfs-data', 'freedom-ipfs');
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
  if (!activeNode || currentState !== STATUS.RUNNING) return false;
  if (typeof activeNode.isHealthy === 'function' && !activeNode.isHealthy()) return false;
  try {
    activeNode.nativeGatewayStatsJson();
    return true;
  } catch (err) {
    log.warn('[IPFS] Native health check failed:', err.message);
    return false;
  }
}

function stopHealthCheck() {
  if (!healthCheckInterval) return;
  clearInterval(healthCheckInterval);
  healthCheckInterval = null;
}

function handleNativeNodeFailure(reason, node = activeNode) {
  if (node && activeNode && node !== activeNode) return;
  if (![STATUS.STARTING, STATUS.RUNNING].includes(currentState)) return;

  const message = reason || 'Native node unavailable';
  const failedNode = activeNode;
  activeNode = null;
  stopHealthCheck();
  clearService('ipfs');
  setStatusMessage('ipfs', 'Node unavailable');
  setErrorState('ipfs', 'Node unavailable. Restart IPFS from the nodes menu.');
  updateState(STATUS.ERROR, message);

  if (failedNode) {
    failedNode.stop().catch((err) => {
      log.warn('[IPFS] Error while cleaning up failed freedom-ipfs native node:', err.message);
    });
  }
}

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(() => {
    const isHealthy = checkHealth();
    if (!isHealthy && currentState === STATUS.RUNNING) {
      handleNativeNodeFailure('Native node unavailable');
    }
  }, 5000);
  healthCheckInterval.unref?.();
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
  const node = new FreedomIpfsNativeNode({
    dataDir,
    onFailure: (reason, failedNode) => handleNativeNodeFailure(reason, failedNode),
  });

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
  if (currentState === STATUS.STOPPED && !activeNode) {
    clearService('ipfs');
    return;
  }
  updateState(STATUS.STOPPING);
  stopHealthCheck();

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
  clearErrorState('ipfs');
  clearService('ipfs');

  if (pendingStart) {
    pendingStart = false;
    setTimeout(() => startIpfs(), 100);
  }
}

async function serveNativeGatewayRequest({ path: gatewayPath, method, headers, signal }) {
  if (!activeNode || currentState !== STATUS.RUNNING || !checkHealth()) {
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
  try {
    return {
      progress: activeNode.progressSnapshotJson(),
      nativeGatewayStats: activeNode.nativeGatewayStatsJson(),
    };
  } catch (err) {
    log.warn('[IPFS] Failed to collect native diagnostics:', err.message);
    return { progress: '{"active":[],"events":[]}', nativeGatewayStats: '{}' };
  }
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
  checkHealth,
  STATUS,
};
