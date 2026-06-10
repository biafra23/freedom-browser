const log = require('./logger');
const { ipcMain, app } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const { loadSettings } = require('./settings-store');
const registry = require('./networks/network-registry');
const {
  MODE,
  DEFAULTS,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');

// States
const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let antProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;

const CONFIG_FILE = 'config.yaml';
const ANT_NODE_MODE = {
  ULTRA_LIGHT: 'ultraLight',
  LIGHT: 'light',
};
const ETHEREUM_CHAIN_ID = 1;
const GNOSIS_CHAIN_ID = 100;
const DEFAULT_ANT_RESOLVER_RPC_URL = 'https://ethereum.publicnode.com';

// Identity injection flag - when true, skip bee init and use pre-injected keys
let useInjectedIdentity = false;

// Port configuration (resolved at startup)
// Note: Newer Bee versions serve debug endpoints on the main API port
let currentApiPort = DEFAULTS.ant.apiPort;
let currentMode = MODE.NONE;

function getAntBinaryPath() {
  const arch = process.arch;

  // Map Node.js platform names to our folder names
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  // In dev, ant-bin is at project root (../../ from src/main)
  let basePath = path.join(__dirname, '..', '..', 'ant-bin');

  if (app.isPackaged) {
    basePath = path.join(process.resourcesPath, 'ant-bin');
    const binName = process.platform === 'win32' ? 'antd.exe' : 'antd';
    return path.join(basePath, binName);
  }

  const binName = process.platform === 'win32' ? 'antd.exe' : 'antd';
  return path.join(basePath, `${platform}-${arch}`, binName);
}

function getAntDataPath() {
  // Explicit override for tests / advanced users — keeps a live E2E
  // run from clobbering the developer's persistent dev `ant-data/`.
  // Honoured in both dev and packaged modes; only set this when you
  // want a throwaway repo (and you're prepared for the node to re-init
  // identity, swarm key, peerstore, etc.).
  if (process.env.FREEDOM_ANT_DATA) {
    const overrideDir = process.env.FREEDOM_ANT_DATA;
    if (!fs.existsSync(overrideDir)) {
      fs.mkdirSync(overrideDir, { recursive: true });
    }
    return overrideDir;
  }
  if (!app.isPackaged) {
    // In dev, ant-data is at project root (../../ from src/main)
    const devDataDir = path.join(__dirname, '..', '..', 'ant-data');
    if (!fs.existsSync(devDataDir)) {
      fs.mkdirSync(devDataDir, { recursive: true });
    }
    return devDataDir;
  }

  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'ant-data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

function getConfiguredAntNodeMode() {
  const settings = loadSettings();
  return settings?.antNodeMode === ANT_NODE_MODE.LIGHT
    ? ANT_NODE_MODE.LIGHT
    : ANT_NODE_MODE.ULTRA_LIGHT;
}

function getPrimaryKeylessRpcUrl(chainId) {
  // Bee config accepts one RPC URL per setting. A keyed commercial provider
  // can have a valid key while a specific chain is disabled for that app, so
  // prefer explicit/user/public keyless sources when available.
  const sources = registry.getEndpointSources(chainId, 'rpc');
  const keyless = sources.find((src) => !src.keyed);
  const keylessUrl = keyless?.coverage?.[String(chainId)];
  if (typeof keylessUrl === 'string' && keylessUrl.trim()) return keylessUrl.trim();

  const [primaryUrl] = registry.getEndpoints(chainId, 'rpc');
  return typeof primaryUrl === 'string' && primaryUrl.trim() ? primaryUrl.trim() : null;
}

function getPrimaryGnosisRpcUrl() {
  return getPrimaryKeylessRpcUrl(GNOSIS_CHAIN_ID);
}

function getPrimaryEthereumRpcUrl() {
  return getPrimaryKeylessRpcUrl(ETHEREUM_CHAIN_ID) || DEFAULT_ANT_RESOLVER_RPC_URL;
}

function buildAntConfigContent({
  dataDir, apiPort, password, nodeMode, blockchainRpcEndpoint, resolverRpcEndpoint,
}) {
  const isLightNode = nodeMode === ANT_NODE_MODE.LIGHT;

  return `# Ant node configuration (bee-compatible keys)
api-addr: 127.0.0.1:${apiPort}
swap-enable: ${isLightNode ? 'true' : 'false'}
mainnet: true
full-node: false
blockchain-rpc-endpoint: ${isLightNode ? `"${blockchainRpcEndpoint}"` : '""'}
cors-allowed-origins: "null"
skip-postage-snapshot: true
resolver-options: "${resolverRpcEndpoint}"
storage-incentives-enable: false
data-dir: ${dataDir}
password: ${password}
`;
}

function ensureConfig(dataDir, apiPort, nodeMode = ANT_NODE_MODE.ULTRA_LIGHT) {
  const configPath = path.join(dataDir, CONFIG_FILE);
  const crypto = require('crypto');

  // Check if config exists and read current password if so
  let password;
  if (fs.existsSync(configPath)) {
    try {
      const existingConfig = fs.readFileSync(configPath, 'utf-8');
      const passwordMatch = existingConfig.match(/^password:\s*(.+)$/m);
      if (passwordMatch) {
        password = passwordMatch[1].trim();
      }
    } catch {
      log.warn('[Ant] Could not read existing password, generating new one');
    }
  }

  // Generate new password if we couldn't read one
  if (!password) {
    password = crypto.randomBytes(32).toString('hex');
  }

  const blockchainRpcEndpoint = nodeMode === ANT_NODE_MODE.LIGHT ? getPrimaryGnosisRpcUrl() : null;
  const resolverRpcEndpoint = getPrimaryEthereumRpcUrl();
  if (nodeMode === ANT_NODE_MODE.LIGHT && !blockchainRpcEndpoint) {
    throw new Error('No primary Gnosis RPC endpoint configured for Ant light mode');
  }

  // Always write config with current port
  // Note: Newer Bee versions don't have separate debug-api-addr, debug endpoints are on main API
  const configContent = buildAntConfigContent({
    dataDir,
    apiPort,
    password,
    nodeMode,
    blockchainRpcEndpoint,
    resolverRpcEndpoint,
  });

  fs.writeFileSync(configPath, configContent);
  log.info(
    `[Ant] Config written at ${configPath} with API:${apiPort} mode:${nodeMode}${
      blockchainRpcEndpoint ? ` rpc:${blockchainRpcEndpoint}` : ''
    }`
  );

  // Identity handling. Unlike bee, antd has no `init` subcommand: when an
  // injected Web3 v3 keystore exists at `keys/swarm.key` antd loads its
  // identity from it; otherwise antd self-generates a native identity
  // (`identity.json`) on start. So there is no separate init step to run —
  // we only log which path will be taken. (startAnt never reaches this point
  // in injected-identity mode without the keystore — it defers instead.)
  const keysDir = path.join(dataDir, 'keys');
  const swarmKeyPath = path.join(keysDir, 'swarm.key');

  if (fs.existsSync(swarmKeyPath)) {
    log.info('[Ant] Using injected keys from', keysDir);
  } else {
    log.info('[Ant] No injected keystore; antd will self-initialize its node identity on start');
  }

  return configPath;
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  // Broadcast to all windows
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.ANT_STATUS_UPDATE, { status: currentState, error: lastError });
  }
}

/**
 * Check if a port is open (something is listening)
 */
function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Probe Bee health endpoint
 */
function probeAntApi(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ valid: true, data: parsed });
          } catch {
            resolve({ valid: false });
          }
        });
      } else {
        resolve({ valid: false });
        res.resume();
      }
    });

    req.on('error', () => resolve({ valid: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false });
    });
    req.end();
  });
}

/**
 * Find an available port starting from the default
 */
async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.ant.fallbackRange) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    const open = await isPortOpen(port);
    if (!open) {
      return port;
    }
    log.info(`[Ant] Port ${port} is busy, trying next...`);
  }
  return null;
}

/**
 * Detect if an existing Bee daemon is running and reusable
 * Always checks default port first to detect conflicts properly
 */
async function detectExistingDaemon() {
  const defaultPort = DEFAULTS.ant.apiPort;

  // First check if anything is on the default API port
  const portOpen = await isPortOpen(defaultPort);
  if (!portOpen) {
    return { found: false };
  }

  // Probe to see if it's actually Bee
  const probe = await probeAntApi(defaultPort);
  if (probe.valid) {
    log.info('[Ant] Found existing daemon on port', defaultPort);
    return {
      found: true,
      port: defaultPort,
      version: probe.data?.version,
    };
  }

  // Port is open but not Bee - conflict
  log.info('[Ant] Port', defaultPort, 'is busy (not an Ant daemon)');
  return { found: false, conflict: true, port: defaultPort };
}

async function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${currentApiPort}/health`, { timeout: 2000 }, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        resolve(false);
      }
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function startHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  healthCheckInterval = setInterval(async () => {
    const isHealthy = await checkHealth();
    if (!isHealthy && currentState === STATUS.RUNNING) {
      updateState(STATUS.ERROR, 'Health check failed');
      setErrorState('ant', 'Node unreachable. Retrying…');
    } else if (isHealthy && currentState === STATUS.ERROR) {
      // Recovered - clear error state (reveals original statusMessage)
      clearErrorState('ant');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

async function startAnt() {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[Ant] Ignoring start request, current state: ${currentState}`);
    return;
  }

  if (currentState === STATUS.STOPPING) {
    log.info('[Ant] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  pendingStart = false;
  updateState(STATUS.STARTING);

  // Step 1: Detect existing daemon
  const existing = await detectExistingDaemon();

  if (existing.found) {
    // Reuse existing daemon
    currentApiPort = existing.port;
    currentMode = MODE.REUSED;

    updateService('ant', {
      api: `http://127.0.0.1:${currentApiPort}`,
      gateway: `http://127.0.0.1:${currentApiPort}`,
      mode: MODE.REUSED,
    });
    setStatusMessage('ant', `Node: localhost:${currentApiPort}`);

    updateState(STATUS.RUNNING);
    startHealthCheck();
    log.info('[Ant] Reusing existing daemon on port', currentApiPort);
    return;
  }

  // Step 2: Start bundled node — but never on a data dir whose identity
  // migration hasn't completed. If the bee-data → ant-data migration failed
  // (it retries on next launch), spawning antd now would self-generate a
  // throwaway identity and the user's first post-upgrade session would run
  // under the wrong overlay address. This guards every start path: launch
  // auto-start, the IPC handler, and onboarding. (Reusing an external daemon
  // above is fine — it has its own data dir.)
  const { isBeeDataMigrationPending } = require('./migrate-user-data');
  if (isBeeDataMigrationPending()) {
    const msg =
      'Node start blocked: the Bee → Ant identity migration has not completed. Restart Freedom to retry.';
    log.error(`[Ant] ${msg}`);
    updateState(STATUS.ERROR, msg);
    setStatusMessage('ant', 'Node start deferred (identity migration pending)');
    return;
  }

  const binPath = getAntBinaryPath();
  if (!fs.existsSync(binPath)) {
    updateState(STATUS.ERROR, `Ant binary not found at ${binPath}`);
    setStatusMessage('ant', 'Node failed to start');
    return;
  }

  const dataDir = getAntDataPath();

  // In injected-identity mode (an identity vault exists) never spawn antd
  // without the injected keystore: antd would self-generate a throwaway
  // native identity — wrong overlay address, none of the user's postage
  // stamps or chequebook funds. IPFS and Radicle defer the same way. The
  // identity lifecycle start hook retries this start after injection, and
  // launch auto-start picks it up once keys/swarm.key exists.
  if (useInjectedIdentity && !fs.existsSync(path.join(dataDir, 'keys', 'swarm.key'))) {
    const msg =
      'Node start deferred: identity vault present but no node key injected yet. Complete identity setup to start the node.';
    log.warn(`[Ant] ${msg}`);
    updateState(STATUS.ERROR, msg);
    setStatusMessage('ant', 'Node start deferred (waiting for identity injection)');
    return;
  }

  // Step 3: Resolve ports (handle conflicts)
  // Always try default port first
  let apiPort = DEFAULTS.ant.apiPort;
  let usingFallbackPort = false;

  // Check if default API port is available
  if (existing.conflict) {
    const newApiPort = await findAvailablePort(apiPort + 1);
    if (!newApiPort) {
      updateState(STATUS.ERROR, 'No available ports for Ant API');
      setStatusMessage('ant', 'Node failed to start');
      return;
    }
    usingFallbackPort = true;
    apiPort = newApiPort;
  }

  currentApiPort = apiPort;
  currentMode = MODE.BUNDLED;

  const configuredNodeMode = getConfiguredAntNodeMode();
  let configPath;
  try {
    configPath = ensureConfig(dataDir, apiPort, configuredNodeMode);
  } catch (err) {
    log.error('[Ant] Failed to prepare config:', err.message);
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ant', 'Node failed to start');
    return;
  }

  // antd is flag-only (no `start` subcommand): it runs the node directly from
  // the bee-compatible YAML config Freedom writes.
  const args = [`--config=${configPath}`];

  log.info(`[Ant] Starting: ${binPath} ${args.join(' ')}`);

  try {
    antProcess = spawn(binPath, args);

    antProcess.stdout.on('data', (data) => {
      log.info(`[Ant stdout]: ${data}`);
    });

    antProcess.stderr.on('data', (data) => {
      log.error(`[Ant stderr]: ${data}`);
    });

    antProcess.on('close', (code) => {
      log.info(`[Ant] Process exited with code ${code}`);
      antProcess = null;

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }

      if (currentState !== STATUS.STOPPING) {
        updateState(STATUS.STOPPED, code !== 0 ? `Exited with code ${code}` : null);
      } else {
        updateState(STATUS.STOPPED);
      }
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      clearService('ant');

      if (pendingStart) {
        log.info('[Ant] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startAnt(), 100);
      }
    });

    antProcess.on('error', (err) => {
      log.error('[Ant] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('ant', 'Node failed to start');
    });

    // Poll for health until running
    let attempts = 0;
    const maxAttempts = 60;
    const pollInterval = setInterval(async () => {
      if (currentState === STATUS.STOPPED || currentState === STATUS.ERROR) {
        clearInterval(pollInterval);
        return;
      }

      const isHealthy = await checkHealth();
      if (isHealthy) {
        clearInterval(pollInterval);

        // Update registry (API and gateway are same port in newer Bee)
        updateService('ant', {
          api: `http://127.0.0.1:${currentApiPort}`,
          gateway: `http://127.0.0.1:${currentApiPort}`,
          mode: MODE.BUNDLED,
        });

        // Only show status line if using fallback port
        if (usingFallbackPort) {
          setStatusMessage('ant', `Fallback Port: ${currentApiPort}`);
        } else {
          // Clear any previous status for normal healthy state
          setStatusMessage('ant', null);
        }

        updateState(STATUS.RUNNING);
        startHealthCheck();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          stopAnt();
          updateState(STATUS.ERROR, 'Startup timed out');
          setStatusMessage('ant', 'Node failed to start');
        }
      }
    }, 1000);
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ant', 'Node failed to start');
  }
}

// Stop Bee and return a Promise that resolves when the process exits
function stopAnt() {
  return new Promise((resolve) => {
    pendingStart = false;

    // If we reused an external daemon, just clear state (don't stop it)
    if (currentMode === MODE.REUSED) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('ant');
      currentMode = MODE.NONE;
      resolve();
      return;
    }

    if (!antProcess) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('ant');
      resolve();
      return;
    }

    // Listen for the process to exit
    const onExit = () => {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      resolve();
    };

    antProcess.once('close', onExit);

    updateState(STATUS.STOPPING);
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    // Try graceful shutdown via SIGTERM
    antProcess.kill('SIGTERM');

    // Force kill if it doesn't exit within 5 seconds
    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (antProcess) {
        log.warn('[Ant] Force killing process...');
        antProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 5000);

    // Try graceful shutdown via SIGTERM
    antProcess.kill('SIGTERM');
  });
}

function checkBinary() {
  const binPath = getAntBinaryPath();
  return fs.existsSync(binPath);
}

/**
 * Enable injected identity mode - skip bee init and expect pre-injected keys
 * Call this before starting Bee when using the unified identity system
 */
function setUseInjectedIdentity(enabled) {
  useInjectedIdentity = enabled;
  log.info(`[Ant] Injected identity mode: ${enabled}`);
}

/**
 * Check if keys have been injected
 */
function hasInjectedKeys() {
  const dataDir = getAntDataPath();
  const swarmKeyPath = path.join(dataDir, 'keys', 'swarm.key');
  return fs.existsSync(swarmKeyPath);
}

function getActivePort() {
  return currentApiPort;
}

function getStatus() {
  return { status: currentState, error: lastError };
}

function registerAntIpc() {
  ipcMain.handle(IPC.ANT_START, async () => {
    await startAnt();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.ANT_STOP, async () => {
    await stopAnt();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.ANT_GET_STATUS, () => {
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.ANT_CHECK_BINARY, () => {
    return { available: checkBinary() };
  });
}

function hasLiveProcess() {
  return antProcess !== null;
}

// States in which a Bee node may still hold the statestore LevelDB lock even
// without a managed child process we can see: RUNNING also covers a reused
// external daemon (antProcess is null) and ERROR can be set by a failed health
// check without the process being killed.
const LOCK_HOLDING_STATES = new Set([
  STATUS.RUNNING,
  STATUS.STARTING,
  STATUS.STOPPING,
  STATUS.ERROR,
]);

// Lifecycle hooks for identity (re)injection: the injector must stop a Bee
// node that holds the statestore LevelDB lock before wiping it, then restart
// it with the new key. Any live process is treated as active (STARTING grabs
// the lock before health passes; STOPPING is before the close event; ERROR can
// leave the process alive), otherwise the wipe fails with EPERM on Windows
// (issue #90). Dependencies are injectable so the decision can be unit-tested
// without spawning a real node.
function createAntLifecycle(deps = {}) {
  const getStatusFn = deps.getStatus || getStatus;
  const hasLiveProcessFn = deps.hasLiveProcess || hasLiveProcess;
  const stopFn = deps.stopAnt || stopAnt;
  const startFn = deps.startAnt || startAnt;
  const setInjected = deps.setUseInjectedIdentity || setUseInjectedIdentity;
  return {
    stop: async () => {
      const status = getStatusFn().status;
      const active = hasLiveProcessFn() || LOCK_HOLDING_STATES.has(status);
      if (active) await stopFn();
      return active;
    },
    start: async () => {
      setInjected(true);
      await startFn();
    },
  };
}

module.exports = {
  registerAntIpc,
  createAntLifecycle,
  hasLiveProcess,
  startAnt,
  stopAnt,
  getActivePort,
  getStatus,
  getAntDataPath,
  setUseInjectedIdentity,
  hasInjectedKeys,
  ANT_NODE_MODE,
  getConfiguredAntNodeMode,
  getPrimaryGnosisRpcUrl,
  getPrimaryEthereumRpcUrl,
  STATUS,
};
