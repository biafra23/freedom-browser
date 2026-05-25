const log = require('./logger');
const { ipcMain, app } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const { getIpfsDataDir } = require('./profile-paths');
const { getActiveProfile, updateActiveProfileNodeConfig } = require('./profile-resolver');
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
let ipfsProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;

// Identity injection flag - when true, skip ipfs init and use pre-injected identity
let useInjectedIdentity = false;

// Port configuration (resolved at startup)
let currentApiPort = DEFAULTS.ipfs.apiPort;
let currentGatewayPort = DEFAULTS.ipfs.gatewayPort;
let currentApiUrl = `http://127.0.0.1:${DEFAULTS.ipfs.apiPort}`;
let currentGatewayUrl = `http://localhost:${DEFAULTS.ipfs.gatewayPort}`;
let currentMode = MODE.NONE;

function getIpfsBinaryPath() {
  const arch = process.arch;

  // Map Node.js platform names to our folder names
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  let basePath = path.join(__dirname, '..', '..', 'ipfs-bin');

  if (app.isPackaged) {
    basePath = path.join(process.resourcesPath, 'ipfs-bin');
    const binName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';
    return path.join(basePath, binName);
  }

  const binName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';
  return path.join(basePath, `${platform}-${arch}`, binName);
}

function getIpfsDataPath() {
  return getIpfsDataDir();
}

function getProfileIpfsConfig() {
  return getActiveProfile()?.metadata?.nodes?.ipfs || null;
}

function isManagedIpfsConfig(config = getProfileIpfsConfig()) {
  return config?.mode === 'managed';
}

function isExternalIpfsConfig(config = getProfileIpfsConfig()) {
  return config?.mode === 'external';
}

function isDisabledIpfsConfig(config = getProfileIpfsConfig()) {
  return config?.mode === 'disabled';
}

function hasUnknownIpfsMode(config) {
  return Boolean(config?.mode) && !isManagedIpfsConfig(config)
    && !isExternalIpfsConfig(config)
    && !isDisabledIpfsConfig(config);
}

function getConfiguredIpfsApiPort(config = getProfileIpfsConfig()) {
  return Number.isInteger(config?.apiPort) ? config.apiPort : DEFAULTS.ipfs.apiPort;
}

function getConfiguredIpfsGatewayPort(config = getProfileIpfsConfig()) {
  return Number.isInteger(config?.gatewayPort)
    ? config.gatewayPort
    : DEFAULTS.ipfs.gatewayPort;
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

function buildApiRequestOptions(apiUrl, apiPath) {
  const endpoint = new URL(apiUrl);
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = `${basePath}${apiPath}`;
  endpoint.search = '';
  endpoint.hash = '';

  return {
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : (endpoint.protocol === 'https:' ? 443 : 80),
    path: endpoint.pathname,
    method: 'POST',
    headers: {
      'Content-Length': 0,
    },
    timeout: 2000,
  };
}

function getHttpClient(protocol) {
  return protocol === 'https:' ? https : http;
}

function persistManagedIpfsPorts(apiPort, gatewayPort) {
  const result = updateActiveProfileNodeConfig('ipfs', { apiPort, gatewayPort });
  if (result) {
    log.info('[IPFS] Persisted managed profile ports:', {
      apiPort,
      gatewayPort,
    });
  }
}

function isRepoInitialized(dataDir) {
  return fs.existsSync(path.join(dataDir, 'config'));
}

// Clean up stale lock file from unclean shutdown
function cleanupStaleLock(dataDir) {
  const lockPath = path.join(dataDir, 'repo.lock');
  if (fs.existsSync(lockPath)) {
    log.info('[IPFS] Removing stale repo.lock file from previous unclean shutdown');
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      log.warn('[IPFS] Failed to remove stale lock file:', err.message);
    }
  }
}

function initRepo(binPath, dataDir) {
  if (isRepoInitialized(dataDir)) {
    log.info('[IPFS] Repo already initialized');
    return true;
  }

  // Check if identity was injected (identity-manager creates config with Identity fields)
  const markerPath = path.join(dataDir, '.identity-injected');
  if (useInjectedIdentity || fs.existsSync(markerPath)) {
    log.info('[IPFS] Using injected identity, skipping ipfs init');
    // Config should already exist with injected identity
    if (isRepoInitialized(dataDir)) {
      return true;
    }
    // If config doesn't exist yet, wait for identity injection
    log.info('[IPFS] Waiting for identity injection...');
    return false;
  }

  log.info('[IPFS] Initializing repo...');
  try {
    const { execSync } = require('child_process');
    execSync(`"${binPath}" init`, {
      env: { ...process.env, IPFS_PATH: dataDir },
      stdio: 'pipe',
    });

    log.info('[IPFS] Repo initialized successfully');
    return true;
  } catch (err) {
    log.error('[IPFS] Init failed:', err.message);
    return false;
  }
}

// Enforce our config settings on every startup (not just first init)
function enforceConfig(dataDir, apiPort, gatewayPort) {
  const configPath = path.join(dataDir, 'config');
  if (!fs.existsSync(configPath)) {
    log.error('[IPFS] Config file not found');
    return false;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // API settings - use resolved ports
    config.Addresses = config.Addresses || {};
    config.Addresses.API = `/ip4/127.0.0.1/tcp/${apiPort}`;
    config.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${gatewayPort}`;

    config.API = config.API || {};
    config.API.HTTPHeaders = config.API.HTTPHeaders || {};
    config.API.HTTPHeaders['Access-Control-Allow-Origin'] = ['null'];
    config.API.HTTPHeaders['Access-Control-Allow-Methods'] = ['GET', 'POST', 'PUT'];

    // Delegated routing: autoclient (DHT client mode) + IPNI for fast provider discovery
    // - autoclient: like dhtclient but with HTTP router support, never becomes DHT server
    // - DelegatedRouters: adds IPNI (cid.contact) on top of DHT for find-providers
    // This keeps full DHT connectivity (~150 peers) while adding fast IPNI lookups.
    config.Routing = {
      Type: 'autoclient',
      DelegatedRouters: ['https://cid.contact'],
    };

    // Disable HTTPRetrieval (not needed with current setup)
    if (config.HTTPRetrieval) {
      delete config.HTTPRetrieval.Enabled;
    }


    // Connection limits - balanced for embedded use while still able to fetch content
    config.Swarm = config.Swarm || {};
    config.Swarm.ConnMgr = config.Swarm.ConnMgr || {};
    config.Swarm.ConnMgr.LowWater = 50;
    config.Swarm.ConnMgr.HighWater = 150;
    config.Swarm.ConnMgr.GracePeriod = '60s';

    // Don't relay for others
    config.Swarm.RelayService = config.Swarm.RelayService || {};
    config.Swarm.RelayService.Enabled = false;

    // Disable reproviding (use new 'Provide' config)
    config.Provide = config.Provide || {};
    config.Provide.Enabled = false;

    // Disable local discovery
    config.Discovery = config.Discovery || {};
    config.Discovery.MDNS = config.Discovery.MDNS || {};
    config.Discovery.MDNS.Enabled = false;

    // DNS-over-HTTPS for reliable resolution on networks with broken/slow local DNS
    // (e.g. mobile hotspots). Required for dnsaddr resolution (Pinata) and DNSLink (IPNS).
    config.DNS = config.DNS || {};
    config.DNS.Resolvers = {
      '.': 'https://cloudflare-dns.com/dns-query',
      'eth.': 'https://dns.eth.limo/dns-query',
    };

    // Disable swarm listening on all interfaces to prevent macOS local network prompt
    // As a DHT client, we only need outbound connections - we don't need to accept incoming
    config.Addresses.Swarm = [];

    // Disable AutoTLS since we have no swarm listeners
    config.AutoTLS = config.AutoTLS || {};
    config.AutoTLS.Enabled = false;
    config.AutoTLS.AutoWSS = false;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    log.info('[IPFS] Config enforced with API port:', apiPort, 'Gateway port:', gatewayPort);
    log.info('[IPFS] Routing: autoclient + DelegatedRouters:', config.Routing.DelegatedRouters);
    return true;
  } catch (err) {
    log.error('[IPFS] Failed to enforce config:', err.message);
    return false;
  }
}

function dumpConfig(dataDir) {
  const configPath = path.join(dataDir, 'config');
  if (!fs.existsSync(configPath)) {
    log.info('[IPFS] No config file found');
    return;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    log.info('[IPFS] ========== CONFIG DUMP ==========');
    log.info('[IPFS] Routing.Type:', config.Routing?.Type || 'default');
    if (config.Routing?.DelegatedRouters?.length > 0) {
      log.info('[IPFS] Routing.DelegatedRouters:', config.Routing.DelegatedRouters.join(', '));
    }
    log.info('[IPFS] Swarm.ConnMgr:', JSON.stringify(config.Swarm?.ConnMgr, null, 2));
    log.info('[IPFS] Discovery.MDNS:', JSON.stringify(config.Discovery?.MDNS, null, 2));
    log.info('[IPFS] Provide:', JSON.stringify(config.Provide, null, 2));
    log.info('[IPFS] ====================================');
  } catch (err) {
    log.error('[IPFS] Failed to dump config:', err.message);
  }
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.IPFS_STATUS_UPDATE, { status: currentState, error: lastError });
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
 * Probe IPFS API health endpoint
 */
function probeIpfsApiUrl(apiUrl) {
  return new Promise((resolve) => {
    const options = buildApiRequestOptions(apiUrl, '/api/v0/id');

    const req = getHttpClient(options.protocol).request(options, (res) => {
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

function probeIpfsApi(port) {
  return probeIpfsApiUrl(`http://127.0.0.1:${port}`);
}

/**
 * Find an available port starting from the default
 */
async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.ipfs.fallbackRange) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    const open = await isPortOpen(port);
    if (!open) {
      return port;
    }
    log.info(`[IPFS] Port ${port} is busy, trying next...`);
  }
  return null;
}

/**
 * Detect if an existing IPFS daemon is running and reusable
 * Always checks default port first to detect conflicts properly
 */
async function detectExistingDaemon() {
  const defaultPort = DEFAULTS.ipfs.apiPort;

  // First check if anything is on the default API port
  const portOpen = await isPortOpen(defaultPort);
  if (!portOpen) {
    return { found: false };
  }

  // Probe to see if it's actually IPFS
  const probe = await probeIpfsApi(defaultPort);
  if (probe.valid) {
    log.info('[IPFS] Found existing daemon on port', defaultPort);
    return {
      found: true,
      port: defaultPort,
      peerId: probe.data?.ID,
    };
  }

  // Port is open but not IPFS - conflict
  log.info('[IPFS] Port', defaultPort, 'is busy (not an IPFS daemon)');
  return { found: false, conflict: true, port: defaultPort };
}

async function checkHealth() {
  return new Promise((resolve) => {
    const options = buildApiRequestOptions(currentApiUrl, '/api/v0/id');

    const req = getHttpClient(options.protocol).request(options, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        resolve(false);
      }
      res.resume();
    });

    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(async () => {
    const isHealthy = await checkHealth();
    if (!isHealthy && currentState === STATUS.RUNNING) {
      updateState(STATUS.ERROR, 'Health check failed');
      setErrorState('ipfs', 'Node unreachable. Retrying…');
    } else if (isHealthy && currentState === STATUS.ERROR) {
      // Recovered - clear error state (reveals original statusMessage)
      clearErrorState('ipfs');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

async function startExternalIpfs(config) {
  const apiUrl = normalizeExternalUrl(config?.externalApi);
  const gatewayUrl = normalizeExternalUrl(config?.externalGateway);
  if (!apiUrl || !gatewayUrl) {
    updateState(STATUS.ERROR, 'External IPFS endpoints are not configured');
    setStatusMessage('ipfs', 'External node not configured');
    return;
  }

  const probe = await probeIpfsApiUrl(apiUrl);
  if (!probe.valid) {
    updateState(STATUS.ERROR, 'External IPFS API endpoint is unreachable');
    setStatusMessage('ipfs', 'External node unreachable');
    return;
  }

  currentApiUrl = apiUrl;
  currentGatewayUrl = gatewayUrl;
  currentApiPort = getPortFromUrl(apiUrl);
  currentGatewayPort = getPortFromUrl(gatewayUrl);
  currentMode = MODE.EXTERNAL;

  updateService('ipfs', {
    api: currentApiUrl,
    gateway: currentGatewayUrl,
    mode: MODE.EXTERNAL,
  });
  setStatusMessage('ipfs', `External node: ${getEndpointLabel(currentApiUrl)}`);

  updateState(STATUS.RUNNING);
  startHealthCheck();
  log.info('[IPFS] Connected to external API at', currentApiUrl);
}

function startDisabledIpfs() {
  currentApiPort = null;
  currentGatewayPort = null;
  currentApiUrl = null;
  currentGatewayUrl = null;
  currentMode = MODE.DISABLED;
  updateService('ipfs', {
    api: null,
    gateway: null,
    mode: MODE.DISABLED,
  });
  setStatusMessage('ipfs', 'Node disabled for this profile');
  updateState(STATUS.STOPPED);
  log.info('[IPFS] Disabled for active profile');
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

  const profileConfig = getProfileIpfsConfig();
  const managedProfileNode = isManagedIpfsConfig(profileConfig);

  if (hasUnknownIpfsMode(profileConfig)) {
    updateState(STATUS.ERROR, `Unsupported IPFS node mode: ${profileConfig.mode}`);
    setStatusMessage('ipfs', 'Node failed to start');
    return;
  }

  if (isDisabledIpfsConfig(profileConfig)) {
    startDisabledIpfs();
    return;
  }

  if (isExternalIpfsConfig(profileConfig)) {
    await startExternalIpfs(profileConfig);
    return;
  }

  // Step 1: Detect existing daemon unless this profile owns a managed node.
  const existing = managedProfileNode ? { found: false } : await detectExistingDaemon();

  if (existing.found) {
    // Reuse existing daemon
    currentApiPort = existing.port;
    currentGatewayPort = DEFAULTS.ipfs.gatewayPort;
    currentApiUrl = `http://127.0.0.1:${currentApiPort}`;
    currentGatewayUrl = `http://localhost:${currentGatewayPort}`;
    currentMode = MODE.REUSED;

    updateService('ipfs', {
      api: currentApiUrl,
      gateway: currentGatewayUrl,
      mode: MODE.REUSED,
    });
    setStatusMessage('ipfs', `Node: localhost:${currentApiPort}`);

    updateState(STATUS.RUNNING);
    startHealthCheck();
    log.info('[IPFS] Reusing existing daemon on port', currentApiPort);
    return;
  }

  // Step 2: Start bundled node
  const binPath = getIpfsBinaryPath();
  if (!fs.existsSync(binPath)) {
    updateState(STATUS.ERROR, `IPFS binary not found at ${binPath}`);
    setStatusMessage('ipfs', 'Node failed to start');
    return;
  }

  const dataDir = getIpfsDataPath();

  // Clean up stale lock from previous unclean shutdown
  cleanupStaleLock(dataDir);

  // Initialize repo if needed
  if (!initRepo(binPath, dataDir)) {
    updateState(STATUS.ERROR, 'Failed to initialize IPFS repo');
    setStatusMessage('ipfs', 'Node failed to start');
    return;
  }

  // Step 3: Resolve ports (handle conflicts)
  let apiPort = getConfiguredIpfsApiPort(profileConfig);
  let gatewayPort = getConfiguredIpfsGatewayPort(profileConfig);
  const configuredApiPort = apiPort;
  const configuredGatewayPort = gatewayPort;
  let usingFallbackPort = false;

  const managedApiPortBusy = managedProfileNode ? await isPortOpen(apiPort) : false;
  if (existing.conflict || managedApiPortBusy) {
    const newApiPort = await findAvailablePort(apiPort + 1);
    if (!newApiPort) {
      updateState(STATUS.ERROR, 'No available ports for IPFS API');
      setStatusMessage('ipfs', 'Node failed to start');
      return;
    }
    usingFallbackPort = true;
    apiPort = newApiPort;
  }

  // Check gateway port
  const gatewayOpen = await isPortOpen(gatewayPort);
  if (gatewayOpen) {
    const newGatewayPort = await findAvailablePort(gatewayPort + 1);
    if (newGatewayPort) {
      gatewayPort = newGatewayPort;
    }
  }

  if (
    managedProfileNode
    && (apiPort !== configuredApiPort || gatewayPort !== configuredGatewayPort)
  ) {
    try {
      persistManagedIpfsPorts(apiPort, gatewayPort);
    } catch (err) {
      log.error('[IPFS] Failed to persist managed profile ports:', err.message);
      updateState(STATUS.ERROR, 'Failed to save IPFS port assignment');
      setStatusMessage('ipfs', 'Node failed to start');
      return;
    }
  }

  currentApiPort = apiPort;
  currentGatewayPort = gatewayPort;
  currentApiUrl = `http://127.0.0.1:${currentApiPort}`;
  currentGatewayUrl = `http://localhost:${currentGatewayPort}`;
  currentMode = MODE.BUNDLED;

  // Enforce our config settings on every startup
  if (!enforceConfig(dataDir, apiPort, gatewayPort)) {
    updateState(STATUS.ERROR, 'Failed to enforce IPFS config');
    setStatusMessage('ipfs', 'Node failed to start');
    return;
  }

  // Dump config at startup for debugging
  dumpConfig(dataDir);

  const args = ['daemon'];

  log.info(`[IPFS] Starting: IPFS_PATH=${dataDir} ${binPath} ${args.join(' ')}`);

  try {
    ipfsProcess = spawn(binPath, args, {
      env: { ...process.env, IPFS_PATH: dataDir },
    });

    ipfsProcess.stdout.on('data', (data) => {
      log.info(`[IPFS stdout]: ${data}`);
    });

    ipfsProcess.stderr.on('data', (data) => {
      log.error(`[IPFS stderr]: ${data}`);
    });

    ipfsProcess.on('close', (code) => {
      log.info(`[IPFS] Process exited with code ${code}`);
      ipfsProcess = null;

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
      clearService('ipfs');

      if (pendingStart) {
        log.info('[IPFS] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startIpfs(), 100);
      }
    });

    ipfsProcess.on('error', (err) => {
      log.error('[IPFS] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('ipfs', 'Node failed to start');
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

        // Update registry
        updateService('ipfs', {
          api: currentApiUrl,
          gateway: currentGatewayUrl,
          mode: MODE.BUNDLED,
        });

        // Only show status line if using fallback port
        if (usingFallbackPort) {
          setStatusMessage('ipfs', `Fallback Port: ${currentApiPort}`);
        } else {
          // Clear any previous status for normal healthy state
          setStatusMessage('ipfs', null);
        }

        updateState(STATUS.RUNNING);
        startHealthCheck();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          stopIpfs();
          updateState(STATUS.ERROR, 'Startup timed out');
          setStatusMessage('ipfs', 'Node failed to start');
        }
      }
    }, 1000);
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ipfs', 'Node failed to start');
  }
}

// Stop IPFS and return a Promise that resolves when the process exits
function stopIpfs() {
  return new Promise((resolve) => {
    pendingStart = false;

    // If this process does not own a daemon, just clear state.
    if (currentMode === MODE.REUSED || currentMode === MODE.EXTERNAL || currentMode === MODE.DISABLED) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('ipfs');
      currentMode = MODE.NONE;
      resolve();
      return;
    }

    if (!ipfsProcess) {
      updateState(STATUS.STOPPED);
      clearService('ipfs');
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

    ipfsProcess.once('close', onExit);

    updateState(STATUS.STOPPING);
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (ipfsProcess) {
        log.warn('[IPFS] Force killing process...');
        ipfsProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 5000);

    ipfsProcess.kill('SIGTERM');
  });
}

function checkBinary() {
  const binPath = getIpfsBinaryPath();
  return fs.existsSync(binPath);
}

/**
 * Enable injected identity mode - skip ipfs init and expect pre-injected identity
 * Call this before starting IPFS when using the unified identity system
 */
function setUseInjectedIdentity(enabled) {
  useInjectedIdentity = enabled;
  log.info(`[IPFS] Injected identity mode: ${enabled}`);
}

/**
 * Check if identity has been injected
 */
function hasInjectedIdentity() {
  const dataDir = getIpfsDataPath();
  const markerPath = path.join(dataDir, '.identity-injected');
  return fs.existsSync(markerPath);
}

function getActivePort() {
  return currentApiPort;
}

function getActiveGatewayPort() {
  return currentGatewayPort;
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
    return { status: currentState, error: lastError };
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
  STATUS,
};
