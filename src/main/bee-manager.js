const log = require('./logger');
const { ipcMain, app } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const { loadSettings } = require('./settings-store');
const registry = require('./networks/network-registry');
const { getBeeDataDir } = require('./profile-paths');
const {
  getActiveProfile,
  getReservedProfilePorts,
  updateActiveProfileNodeConfig,
} = require('./profile-resolver');
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
let beeProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;

const CONFIG_FILE = 'config.yaml';
const BEE_NODE_MODE = {
  ULTRA_LIGHT: 'ultraLight',
  LIGHT: 'light',
};
const ETHEREUM_CHAIN_ID = 1;
const GNOSIS_CHAIN_ID = 100;
const DEFAULT_BEE_RESOLVER_RPC_URL = 'https://ethereum.publicnode.com';

// Identity injection flag - when true, skip bee init and use pre-injected keys
let useInjectedIdentity = false;

// Port configuration (resolved at startup)
// Note: Newer Bee versions serve debug endpoints on the main API port
let currentApiPort = DEFAULTS.bee.apiPort;
let currentApiUrl = `http://127.0.0.1:${DEFAULTS.bee.apiPort}`;
let currentMode = MODE.NONE;

function getBeeBinaryPath() {
  const arch = process.arch;

  // Map Node.js platform names to our folder names
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  // In dev, bee-bin is at project root (../../ from src/main)
  let basePath = path.join(__dirname, '..', '..', 'bee-bin');

  if (app.isPackaged) {
    basePath = path.join(process.resourcesPath, 'bee-bin');
    const binName = process.platform === 'win32' ? 'bee.exe' : 'bee';
    return path.join(basePath, binName);
  }

  const binName = process.platform === 'win32' ? 'bee.exe' : 'bee';
  return path.join(basePath, `${platform}-${arch}`, binName);
}

function getBeeDataPath() {
  return getBeeDataDir();
}

function getProfileBeeConfig() {
  return getActiveProfile()?.metadata?.nodes?.bee || null;
}

function isManagedBeeConfig(config = getProfileBeeConfig()) {
  return config?.mode === 'managed';
}

function isExternalBeeConfig(config = getProfileBeeConfig()) {
  return config?.mode === 'external';
}

function isDisabledBeeConfig(config = getProfileBeeConfig()) {
  return config?.mode === 'disabled';
}

function hasUnknownBeeMode(config) {
  return Boolean(config?.mode) && !isManagedBeeConfig(config)
    && !isExternalBeeConfig(config)
    && !isDisabledBeeConfig(config);
}

function getConfiguredBeeApiPort(config = getProfileBeeConfig()) {
  return Number.isInteger(config?.apiPort) ? config.apiPort : DEFAULTS.bee.apiPort;
}

function getConfiguredBeeP2pPort(config = getProfileBeeConfig()) {
  return Number.isInteger(config?.p2pPort) ? config.p2pPort : DEFAULTS.bee.p2pPort;
}

function normalizeExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function getPortFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function getEndpointLabel(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

function getHttpClient(rawUrl) {
  return rawUrl.startsWith('https:') ? https : http;
}

function persistManagedBeePorts(updates) {
  const result = updateActiveProfileNodeConfig('bee', updates);
  if (result) {
    log.info('[Bee] Persisted managed profile ports:', updates);
  }
}

function getConfiguredBeeNodeMode() {
  const settings = loadSettings();
  return settings?.beeNodeMode === BEE_NODE_MODE.LIGHT
    ? BEE_NODE_MODE.LIGHT
    : BEE_NODE_MODE.ULTRA_LIGHT;
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
  return getPrimaryKeylessRpcUrl(ETHEREUM_CHAIN_ID) || DEFAULT_BEE_RESOLVER_RPC_URL;
}

function buildBeeConfigContent({
  dataDir, apiPort, p2pPort, password, nodeMode, blockchainRpcEndpoint, resolverRpcEndpoint,
}) {
  const isLightNode = nodeMode === BEE_NODE_MODE.LIGHT;

  return `# Bee Configuration
api-addr: 127.0.0.1:${apiPort}
p2p-addr: :${p2pPort}
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

function ensureConfig(
  dataDir,
  apiPort,
  nodeMode = BEE_NODE_MODE.ULTRA_LIGHT,
  p2pPort = DEFAULTS.bee.p2pPort
) {
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
      log.warn('[Bee] Could not read existing password, generating new one');
    }
  }

  // Generate new password if we couldn't read one
  if (!password) {
    password = crypto.randomBytes(32).toString('hex');
  }

  const blockchainRpcEndpoint = nodeMode === BEE_NODE_MODE.LIGHT ? getPrimaryGnosisRpcUrl() : null;
  const resolverRpcEndpoint = getPrimaryEthereumRpcUrl();
  if (nodeMode === BEE_NODE_MODE.LIGHT && !blockchainRpcEndpoint) {
    throw new Error('No primary Gnosis RPC endpoint configured for Bee light mode');
  }

  // Always write config with current port
  // Note: Newer Bee versions don't have separate debug-api-addr, debug endpoints are on main API
  const configContent = buildBeeConfigContent({
    dataDir,
    apiPort,
    p2pPort,
    password,
    nodeMode,
    blockchainRpcEndpoint,
    resolverRpcEndpoint,
  });

  fs.writeFileSync(configPath, configContent);
  log.info(
    `[Bee] Config written at ${configPath} with API:${apiPort} P2P:${p2pPort} mode:${nodeMode}${
      blockchainRpcEndpoint ? ` rpc:${blockchainRpcEndpoint}` : ''
    }`
  );

  // Initialize keys if this is a fresh config
  // Skip if identity system has injected keys (swarm.key exists)
  const keysDir = path.join(dataDir, 'keys');
  const swarmKeyPath = path.join(keysDir, 'swarm.key');

  if (!fs.existsSync(keysDir)) {
    if (useInjectedIdentity) {
      log.info('[Bee] Waiting for identity injection (useInjectedIdentity=true)');
      // Keys should be injected by identity-manager before starting
    } else {
      const binPath = getBeeBinaryPath();
      try {
        const { execSync } = require('child_process');
        log.info('[Bee] Running init to generate keys...');
        execSync(`"${binPath}" init --config="${configPath}"`);
      } catch (e) {
        log.error('[Bee] Init failed:', e.message);
      }
    }
  } else if (fs.existsSync(swarmKeyPath)) {
    log.info('[Bee] Using existing/injected keys from', keysDir);
  }

  return configPath;
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  // Broadcast to all windows
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.BEE_STATUS_UPDATE, { status: currentState, error: lastError });
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
function probeBeeApiUrl(apiUrl) {
  return new Promise((resolve) => {
    const healthUrl = `${apiUrl}/health`;
    const req = getHttpClient(healthUrl).get(healthUrl, { timeout: 2000 }, (res) => {
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

function probeBeeApi(port) {
  return probeBeeApiUrl(`http://127.0.0.1:${port}`);
}

/**
 * Find an available port starting from the default
 */
async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.bee.fallbackRange, options = {}) {
  const reservedPorts = options.reservedPorts || new Set();
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    if (reservedPorts.has(port)) {
      log.info(`[Bee] Port ${port} is reserved by another profile, trying next...`);
      continue;
    }
    const open = await isPortOpen(port);
    if (!open) {
      return port;
    }
    log.info(`[Bee] Port ${port} is busy, trying next...`);
  }
  return null;
}

/**
 * Detect if an existing Bee daemon is running and reusable
 * Always checks default port first to detect conflicts properly
 */
async function detectExistingDaemon() {
  const defaultPort = DEFAULTS.bee.apiPort;

  // First check if anything is on the default API port
  const portOpen = await isPortOpen(defaultPort);
  if (!portOpen) {
    return { found: false };
  }

  // Probe to see if it's actually Bee
  const probe = await probeBeeApi(defaultPort);
  if (probe.valid) {
    log.info('[Bee] Found existing daemon on port', defaultPort);
    return {
      found: true,
      port: defaultPort,
      version: probe.data?.version,
    };
  }

  // Port is open but not Bee - conflict
  log.info('[Bee] Port', defaultPort, 'is busy (not a Bee daemon)');
  return { found: false, conflict: true, port: defaultPort };
}

async function checkHealth() {
  return new Promise((resolve) => {
    const req = getHttpClient(currentApiUrl).get(`${currentApiUrl}/health`, { timeout: 2000 }, (res) => {
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
      setErrorState('bee', 'Node unreachable. Retrying…');
    } else if (isHealthy && currentState === STATUS.ERROR) {
      // Recovered - clear error state (reveals original statusMessage)
      clearErrorState('bee');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

async function startExternalBee(config) {
  const apiUrl = normalizeExternalUrl(config?.externalApi);
  if (!apiUrl) {
    updateState(STATUS.ERROR, 'External Bee API endpoint is not configured');
    setStatusMessage('bee', 'External node not configured');
    return;
  }

  const probe = await probeBeeApiUrl(apiUrl);
  if (!probe.valid) {
    updateState(STATUS.ERROR, 'External Bee API endpoint is unreachable');
    setStatusMessage('bee', 'External node unreachable');
    return;
  }

  currentApiUrl = apiUrl;
  currentApiPort = getPortFromUrl(apiUrl);
  currentMode = MODE.EXTERNAL;

  updateService('bee', {
    api: currentApiUrl,
    gateway: currentApiUrl,
    mode: MODE.EXTERNAL,
  });
  setStatusMessage('bee', `External node: ${getEndpointLabel(currentApiUrl)}`);

  updateState(STATUS.RUNNING);
  startHealthCheck();
  log.info('[Bee] Connected to external API at', currentApiUrl);
}

function startDisabledBee() {
  currentApiPort = null;
  currentApiUrl = null;
  currentMode = MODE.DISABLED;
  updateService('bee', {
    api: null,
    gateway: null,
    mode: MODE.DISABLED,
  });
  setStatusMessage('bee', 'Node disabled for this profile');
  updateState(STATUS.STOPPED);
  log.info('[Bee] Disabled for active profile');
}

async function startBee() {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[Bee] Ignoring start request, current state: ${currentState}`);
    return;
  }

  if (currentState === STATUS.STOPPING) {
    log.info('[Bee] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  pendingStart = false;
  updateState(STATUS.STARTING);

  const profileConfig = getProfileBeeConfig();
  const managedProfileNode = isManagedBeeConfig(profileConfig);

  if (hasUnknownBeeMode(profileConfig)) {
    updateState(STATUS.ERROR, `Unsupported Bee node mode: ${profileConfig.mode}`);
    setStatusMessage('bee', 'Node failed to start');
    return;
  }

  if (isDisabledBeeConfig(profileConfig)) {
    startDisabledBee();
    return;
  }

  if (isExternalBeeConfig(profileConfig)) {
    await startExternalBee(profileConfig);
    return;
  }

  // Step 1: Legacy/profile-dir launches may still opt into a system daemon.
  const existing = managedProfileNode ? { found: false } : await detectExistingDaemon();

  if (existing.found) {
    // Reuse existing daemon
    currentApiPort = existing.port;
    currentApiUrl = `http://127.0.0.1:${currentApiPort}`;
    currentMode = MODE.REUSED;

    updateService('bee', {
      api: currentApiUrl,
      gateway: currentApiUrl,
      mode: MODE.REUSED,
    });
    setStatusMessage('bee', `Node: localhost:${currentApiPort}`);

    updateState(STATUS.RUNNING);
    startHealthCheck();
    log.info('[Bee] Reusing existing daemon on port', currentApiPort);
    return;
  }

  // Step 2: Start bundled node
  const binPath = getBeeBinaryPath();
  if (!fs.existsSync(binPath)) {
    updateState(STATUS.ERROR, `Bee binary not found at ${binPath}`);
    setStatusMessage('bee', 'Node failed to start');
    return;
  }

  const dataDir = getBeeDataPath();

  // Step 3: Resolve ports (handle conflicts)
  let apiPort = getConfiguredBeeApiPort(profileConfig);
  let p2pPort = getConfiguredBeeP2pPort(profileConfig);
  const configuredApiPort = apiPort;
  const configuredP2pPort = p2pPort;
  let usingFallbackPort = false;
  const reservedProfilePorts = managedProfileNode ? getReservedProfilePorts() : new Set();

  const managedApiPortBusy = managedProfileNode ? await isPortOpen(apiPort) : false;
  if (existing.conflict || managedApiPortBusy) {
    const newApiPort = await findAvailablePort(apiPort + 1, DEFAULTS.bee.fallbackRange, {
      reservedPorts: reservedProfilePorts,
    });
    if (!newApiPort) {
      updateState(STATUS.ERROR, 'No available ports for Bee API');
      setStatusMessage('bee', 'Node failed to start');
      return;
    }
    usingFallbackPort = true;
    apiPort = newApiPort;
  }

  const managedP2pPortBusy = managedProfileNode ? await isPortOpen(p2pPort) : false;
  if (managedP2pPortBusy) {
    const newP2pPort = await findAvailablePort(p2pPort + 1, DEFAULTS.bee.fallbackRange, {
      reservedPorts: reservedProfilePorts,
    });
    if (!newP2pPort) {
      updateState(STATUS.ERROR, 'No available ports for Bee P2P');
      setStatusMessage('bee', 'Node failed to start');
      return;
    }
    p2pPort = newP2pPort;
    usingFallbackPort = true;
  }

  if (managedProfileNode && (apiPort !== configuredApiPort || p2pPort !== configuredP2pPort)) {
    try {
      persistManagedBeePorts({ apiPort, p2pPort });
    } catch (err) {
      log.error('[Bee] Failed to persist managed profile ports:', err.message);
      updateState(STATUS.ERROR, 'Failed to save Bee port assignment');
      setStatusMessage('bee', 'Node failed to start');
      return;
    }
  }

  currentApiPort = apiPort;
  currentApiUrl = `http://127.0.0.1:${currentApiPort}`;
  currentMode = MODE.BUNDLED;

  const configuredNodeMode = getConfiguredBeeNodeMode();
  let configPath;
  try {
    configPath = ensureConfig(dataDir, apiPort, configuredNodeMode, p2pPort);
  } catch (err) {
    log.error('[Bee] Failed to prepare config:', err.message);
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('bee', 'Node failed to start');
    return;
  }

  const args = ['start', `--config=${configPath}`];

  log.info(`[Bee] Starting: ${binPath} ${args.join(' ')}`);

  try {
    beeProcess = spawn(binPath, args);

    beeProcess.stdout.on('data', (data) => {
      log.info(`[Bee stdout]: ${data}`);
    });

    beeProcess.stderr.on('data', (data) => {
      log.error(`[Bee stderr]: ${data}`);
    });

    beeProcess.on('close', (code) => {
      log.info(`[Bee] Process exited with code ${code}`);
      beeProcess = null;

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
      clearService('bee');

      if (pendingStart) {
        log.info('[Bee] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startBee(), 100);
      }
    });

    beeProcess.on('error', (err) => {
      log.error('[Bee] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('bee', 'Node failed to start');
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
        updateService('bee', {
          api: currentApiUrl,
          gateway: currentApiUrl,
          mode: MODE.BUNDLED,
        });

        // Only show status line if using fallback port
        if (usingFallbackPort) {
          setStatusMessage('bee', `Fallback Port: ${currentApiPort}`);
        } else {
          // Clear any previous status for normal healthy state
          setStatusMessage('bee', null);
        }

        updateState(STATUS.RUNNING);
        startHealthCheck();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          stopBee();
          updateState(STATUS.ERROR, 'Startup timed out');
          setStatusMessage('bee', 'Node failed to start');
        }
      }
    }, 1000);
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('bee', 'Node failed to start');
  }
}

// Stop Bee and return a Promise that resolves when the process exits
function stopBee() {
  return new Promise((resolve) => {
    pendingStart = false;

    // If this process does not own a daemon, just clear state.
    if (currentMode === MODE.REUSED || currentMode === MODE.EXTERNAL || currentMode === MODE.DISABLED) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('bee');
      currentMode = MODE.NONE;
      resolve();
      return;
    }

    if (!beeProcess) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('bee');
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

    beeProcess.once('close', onExit);

    updateState(STATUS.STOPPING);
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    // Try graceful shutdown via SIGTERM
    beeProcess.kill('SIGTERM');

    // Force kill if it doesn't exit within 5 seconds
    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (beeProcess) {
        log.warn('[Bee] Force killing process...');
        beeProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 5000);

    // Try graceful shutdown via SIGTERM
    beeProcess.kill('SIGTERM');
  });
}

function checkBinary() {
  const binPath = getBeeBinaryPath();
  return fs.existsSync(binPath);
}

/**
 * Enable injected identity mode - skip bee init and expect pre-injected keys
 * Call this before starting Bee when using the unified identity system
 */
function setUseInjectedIdentity(enabled) {
  useInjectedIdentity = enabled;
  log.info(`[Bee] Injected identity mode: ${enabled}`);
}

/**
 * Check if keys have been injected
 */
function hasInjectedKeys() {
  const dataDir = getBeeDataPath();
  const swarmKeyPath = path.join(dataDir, 'keys', 'swarm.key');
  return fs.existsSync(swarmKeyPath);
}

function getActivePort() {
  return currentApiPort;
}

function registerBeeIpc() {
  ipcMain.handle(IPC.BEE_START, async () => {
    await startBee();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.BEE_STOP, async () => {
    await stopBee();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.BEE_GET_STATUS, () => {
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.BEE_CHECK_BINARY, () => {
    return { available: checkBinary() };
  });
}

module.exports = {
  registerBeeIpc,
  startBee,
  stopBee,
  getActivePort,
  getBeeDataPath,
  setUseInjectedIdentity,
  hasInjectedKeys,
  BEE_NODE_MODE,
  getConfiguredBeeNodeMode,
  getPrimaryGnosisRpcUrl,
  getPrimaryEthereumRpcUrl,
  STATUS,
};
