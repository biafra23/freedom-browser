/**
 * Tor (Arti) node manager.
 *
 * Spawns the bundled `arti` binary as a local SOCKS5 proxy and wires the
 * default Electron session to route `.onion` traffic through it. Mirrors the
 * lifecycle/state-machine shape of `radicle-manager.js` (STATUS states,
 * service-registry broadcasts, IPC handlers gated by an Experimental setting).
 *
 * Arti is the Tor Project's pure-Rust Tor client. We run it in SOCKS-proxy
 * mode (`arti proxy -c <config.toml>`); see README and `scripts/fetch-arti.js`.
 */

const log = require('./logger');
const { ipcMain, app, session } = require('electron');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);
const fs = require('fs');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const { normalizeSocksEndpoint, parseSocksEndpoint } = require('../shared/socks-endpoint');
const { success, failure } = require('./ipc-contract');
const { loadSettings } = require('./settings-store');
const { getTorDataDir } = require('./profile-paths');
const {
  getActiveProfile,
  getReservedProfilePorts,
  updateActiveProfileNodeConfig,
} = require('./profile-resolver');
const { probeSocks5Endpoint } = require('./socks-probe');
const { applyOnionProxy, clearOnionProxy } = require('./tor-proxy');
const {
  MODE,
  DEFAULTS,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');

// States (mirrors radicle-manager.js)
const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let artiProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;
let currentSocksPort = DEFAULTS.tor.socksPort;
let currentSocksEndpoint = `127.0.0.1:${DEFAULTS.tor.socksPort}`;
let proxySession = null;
let artiBootstrapped = false;
let artiOutputBuffer = '';

/**
 * Resolve the bundled arti binary path. Dev layout mirrors radicle:
 *   dev:      <root>/arti-bin/<platform>-<arch>/arti
 *   packaged: <resources>/arti-bin/arti
 */
function getArtiBinaryPath() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'arti.exe' : 'arti';

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'arti-bin', binName);
  }
  return path.join(__dirname, '..', '..', 'arti-bin', `${platform}-${process.arch}`, binName);
}

/**
 * State/cache directory for Arti. Honors FREEDOM_TOR_DATA (tests / advanced
 * users), mirroring the Ant/IPFS/Radicle data-dir overrides. Created with
 * 0700 perms so Arti's filesystem-permission checks pass.
 */
function getTorDataPath() {
  const dir = getTorDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // chmod unconditionally: mkdirSync's mode is subject to the process umask,
  // and a pre-existing dir may have looser perms. Arti refuses to start if its
  // data dir is group/world-accessible.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Non-fatal: on Windows chmod is a no-op and Arti's perm checks differ.
  }
  return dir;
}

function getProfileTorConfig() {
  return getActiveProfile()?.metadata?.nodes?.tor || null;
}

function isManagedTorConfig(config = getProfileTorConfig()) {
  return config?.mode === 'managed';
}

function isExternalTorConfig(config = getProfileTorConfig()) {
  return config?.mode === 'external';
}

function isDisabledTorConfig(config = getProfileTorConfig()) {
  return config?.mode === 'disabled';
}

function hasUnknownTorMode(config) {
  return Boolean(config?.mode) && !isManagedTorConfig(config)
    && !isExternalTorConfig(config)
    && !isDisabledTorConfig(config);
}

function getConfiguredTorSocksPort(config = getProfileTorConfig()) {
  return Number.isInteger(config?.socksPort) ? config.socksPort : DEFAULTS.tor.socksPort;
}

function persistManagedTorPort(socksPort) {
  const result = updateActiveProfileNodeConfig('tor', { socksPort });
  if (result) {
    log.info('[Tor] Persisted managed profile SOCKS port:', socksPort);
  }
}

function setCurrentSocksEndpoint(endpoint) {
  currentSocksEndpoint = endpoint;
  currentSocksPort = parseSocksEndpoint(endpoint)?.port || null;
}

/**
 * Write an arti.toml that pins the SOCKS port and redirects state/cache into
 * our data dir, then return its path.
 */
function writeArtiConfig(dataDir, socksPort) {
  const stateDir = path.join(dataDir, 'state');
  const cacheDir = path.join(dataDir, 'cache');
  for (const d of [stateDir, cacheDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    // chmod unconditionally — same umask/pre-existing-dir rationale as the
    // parent data dir; Arti rejects group/world-accessible state/cache dirs.
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      // Non-fatal on Windows.
    }
  }
  // TOML strings need forward slashes even on Windows; JSON.stringify escapes safely.
  const toml = [
    '[proxy]',
    `socks_listen = ${socksPort}`,
    '',
    '[storage]',
    `cache_dir = ${JSON.stringify(cacheDir)}`,
    `state_dir = ${JSON.stringify(stateDir)}`,
    '',
    '[logging]',
    'console = "info"',
    '',
  ].join('\n');
  const configPath = path.join(dataDir, 'arti.toml');
  fs.writeFileSync(configPath, toml, 'utf-8');
  return configPath;
}

function updateState(newState, error = null) {
  log.info('[Tor] State change:', currentState, '->', newState, error ? `(error: ${error})` : '');
  currentState = newState;
  lastError = error;
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    try {
      win.webContents.send(IPC.TOR_STATUS_UPDATE, { status: currentState, error: lastError });
    } catch {
      // Window might be closing
    }
  }
}

/** Check if a port is open (something is listening). */
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

/** Find an available port starting from the default. */
async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.tor.fallbackRange, options = {}) {
  const reservedPorts = options.reservedPorts || new Set();
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    if (reservedPorts.has(port)) {
      log.info(`[Tor] Port ${port} is reserved by another profile, trying next...`);
      continue;
    }
    const open = await isPortOpen(port);
    if (!open) return port;
    log.info(`[Tor] Port ${port} is busy, trying next...`);
  }
  return null;
}

/** Readiness: the SOCKS endpoint accepts a SOCKS5 greeting. */
async function checkHealth() {
  return probeSocks5Endpoint(currentSocksEndpoint);
}

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(async () => {
    const healthy = await checkHealth();
    if (!healthy && currentState === STATUS.RUNNING) {
      updateState(STATUS.ERROR, 'SOCKS port unreachable');
      setErrorState('tor', 'Tor unreachable. Retrying…');
    } else if (healthy && currentState === STATUS.ERROR) {
      clearErrorState('tor');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

async function applyTorProxy(mode, statusMessage) {
  try {
    await applyOnionProxy(proxySession, currentSocksEndpoint);
  } catch (err) {
    log.error('[Tor] Failed to apply proxy:', err.message);
    updateState(STATUS.ERROR, 'Failed to apply Tor proxy');
    setStatusMessage('tor', 'Tor failed to start');
    return false;
  }

  updateService('tor', {
    socks: currentSocksEndpoint,
    mode,
  });
  setStatusMessage('tor', statusMessage);
  updateState(STATUS.RUNNING);
  startHealthCheck();
  return true;
}

async function startExternalTor(config) {
  const endpoint = normalizeSocksEndpoint(config?.externalSocks);
  if (!endpoint) {
    updateState(STATUS.ERROR, 'External Tor SOCKS endpoint is not configured');
    setStatusMessage('tor', 'External Tor not configured');
    return;
  }

  setCurrentSocksEndpoint(endpoint);
  setStatusMessage('tor', 'Checking external SOCKS…');

  if (!(await checkHealth())) {
    updateState(STATUS.ERROR, 'External Tor SOCKS endpoint is unreachable');
    setStatusMessage('tor', 'External Tor unreachable');
    return;
  }

  if (await applyTorProxy(MODE.EXTERNAL, `External SOCKS: ${currentSocksEndpoint}`)) {
    log.info('[Tor] Connected to external SOCKS at', currentSocksEndpoint);
  }
}

function startDisabledTor() {
  setCurrentSocksEndpoint(`127.0.0.1:${DEFAULTS.tor.socksPort}`);
  clearService('tor');
  updateService('tor', {
    socks: null,
    mode: MODE.DISABLED,
  });
  setStatusMessage('tor', 'Tor disabled for this profile');
  updateState(STATUS.STOPPED);
  log.info('[Tor] Disabled for active profile');
}

function checkBinary() {
  return fs.existsSync(getArtiBinaryPath());
}

let cachedVersion = null;

/**
 * Read the bundled arti binary's version (`arti --version`). Cached after the
 * first successful read since the binary doesn't change at runtime.
 * @returns {Promise<{success: boolean, name?: string, version?: string}>}
 */
async function getArtiVersion() {
  if (cachedVersion) {
    return success({ name: 'Arti', version: cachedVersion });
  }
  const artiPath = getArtiBinaryPath();
  if (!fs.existsSync(artiPath)) {
    return failure('TOR_BINARY_NOT_FOUND', 'arti binary not found');
  }
  try {
    const { stdout, stderr } = await execFileAsync(artiPath, ['--version'], { timeout: 5000 });
    const out = `${stdout || ''}${stderr || ''}`.trim();
    // `arti --version` prints e.g. "arti 1.4.4"; fall back to raw output.
    const match = out.match(/(\d+\.\d+\.\d+[^\s]*)/);
    cachedVersion = match ? match[1] : out;
    return success({ name: 'Arti', version: cachedVersion });
  } catch (err) {
    log.warn('[Tor] version lookup failed:', err.message);
    return failure('TOR_VERSION_FAILED', err.message);
  }
}

function handleArtiLogLine(line) {
  if (/Sufficiently bootstrapped/i.test(line)) {
    artiBootstrapped = true;
    setStatusMessage('tor', 'Tor bootstrapped; opening SOCKS…');
  }
}

function handleArtiOutput(streamName, data) {
  const text = String(data || '');
  log.info(`[arti ${streamName}]: ${text}`);
  artiOutputBuffer += text;
  const lines = artiOutputBuffer.split(/\r?\n/);
  artiOutputBuffer = lines.pop() || '';
  for (const line of lines) {
    handleArtiLogLine(line);
  }

  // If a platform flushes without a trailing newline, still catch the readiness
  // marker. Keep the buffer so a split marker can complete on the next chunk.
  handleArtiLogLine(artiOutputBuffer);
}

/**
 * Start Arti as a SOCKS proxy and route `.onion` through it.
 * @param {object} [opts]
 * @param {import('electron').Session} [opts.targetSession] session to proxy
 */
async function startTor(opts = {}) {
  log.info('[Tor] startTor() called, currentState:', currentState);

  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[Tor] Ignoring start request, current state: ${currentState}`);
    return;
  }
  if (currentState === STATUS.STOPPING) {
    log.info('[Tor] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  proxySession = opts.targetSession || session.defaultSession;

  pendingStart = false;
  updateState(STATUS.STARTING);
  setStatusMessage('tor', 'Bootstrapping…');

  const profileConfig = getProfileTorConfig();
  const managedProfileNode = isManagedTorConfig(profileConfig);

  if (hasUnknownTorMode(profileConfig)) {
    updateState(STATUS.ERROR, `Unsupported Tor node mode: ${profileConfig.mode}`);
    setStatusMessage('tor', 'Tor failed to start');
    return;
  }

  if (isDisabledTorConfig(profileConfig)) {
    startDisabledTor();
    return;
  }

  if (isExternalTorConfig(profileConfig)) {
    await startExternalTor(profileConfig);
    return;
  }

  const artiPath = getArtiBinaryPath();
  if (!fs.existsSync(artiPath)) {
    updateState(STATUS.ERROR, `arti binary not found at ${artiPath}`);
    setStatusMessage('tor', 'Tor binary not found');
    return;
  }

  // Resolve a free SOCKS port (profile default, fall back if busy/reserved).
  let socksPort = getConfiguredTorSocksPort(profileConfig);
  const configuredSocksPort = socksPort;
  const reservedProfilePorts = managedProfileNode ? getReservedProfilePorts() : new Set();
  const configuredPortUnavailable =
    reservedProfilePorts.has(socksPort) || (await isPortOpen(socksPort));

  if (configuredPortUnavailable) {
    const next = await findAvailablePort(socksPort + 1, DEFAULTS.tor.fallbackRange, {
      reservedPorts: reservedProfilePorts,
    });
    if (!next) {
      updateState(STATUS.ERROR, 'No available ports for Tor SOCKS proxy');
      setStatusMessage('tor', 'Tor failed to start');
      return;
    }
    socksPort = next;
  }

  if (managedProfileNode && socksPort !== configuredSocksPort) {
    try {
      persistManagedTorPort(socksPort);
    } catch (err) {
      log.error('[Tor] Failed to persist managed profile SOCKS port:', err.message);
      updateState(STATUS.ERROR, 'Failed to save Tor port assignment');
      setStatusMessage('tor', 'Tor failed to start');
      return;
    }
  }

  setCurrentSocksEndpoint(`127.0.0.1:${socksPort}`);
  artiBootstrapped = false;
  artiOutputBuffer = '';

  let configPath;
  try {
    configPath = writeArtiConfig(getTorDataPath(), socksPort);
  } catch (err) {
    updateState(STATUS.ERROR, `Failed to write arti config: ${err.message}`);
    setStatusMessage('tor', 'Tor failed to start');
    return;
  }

  log.info(`[Tor] Starting arti: ${artiPath} proxy -c ${configPath} (SOCKS ${socksPort})`);
  try {
    artiProcess = spawn(artiPath, ['proxy', '-c', configPath], {
      env: { ...process.env },
    });
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('tor', 'Tor failed to start');
    return;
  }

  artiProcess.stdout.on('data', (data) => handleArtiOutput('stdout', data));
  artiProcess.stderr.on('data', (data) => handleArtiOutput('stderr', data));

  artiProcess.on('error', (err) => {
    log.error('[Tor] Failed to start process:', err);
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('tor', 'Tor failed to start');
  });

  artiProcess.on('close', (code) => {
    log.info(`[Tor] arti process exited with code ${code}`);
    artiProcess = null;
    artiBootstrapped = false;
    artiOutputBuffer = '';
    if (forceKillTimeout) {
      clearTimeout(forceKillTimeout);
      forceKillTimeout = null;
    }
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
    // Tear down the proxy so clearnet isn't pointed at a dead SOCKS port.
    if (proxySession) clearOnionProxy(proxySession).catch(() => {});
    if (currentState !== STATUS.STOPPING && code !== 0) {
      // Unexpected exit (crash / killed): surface it as an error and keep the
      // service entry so the menu shows a failure indication, rather than a
      // silent stop that looks identical to a clean shutdown.
      updateState(STATUS.ERROR, `arti exited with code ${code}`);
      setErrorState('tor', `Tor exited unexpectedly (code ${code})`);
    } else {
      updateState(STATUS.STOPPED);
      clearService('tor');
    }

    if (pendingStart) {
      pendingStart = false;
      setTimeout(() => startTor({ targetSession: proxySession }), 100);
    }
  });

  // Poll for the SOCKS endpoint to come up, then wait for Arti's bootstrap
  // marker before routing Chromium traffic through it.
  let attempts = 0;
  const maxAttempts = 120; // up to ~120s for first bootstrap
  const pollInterval = setInterval(async () => {
    if (currentState === STATUS.STOPPED || currentState === STATUS.ERROR || !artiProcess) {
      clearInterval(pollInterval);
      return;
    }
    const socksReady = await checkHealth();
    if (socksReady && artiBootstrapped) {
      clearInterval(pollInterval);
      await applyTorProxy(MODE.BUNDLED, `SOCKS: ${currentSocksEndpoint}`);
    } else {
      attempts++;
      if (socksReady) {
        setStatusMessage('tor', 'Bootstrapping Tor network…');
      }
      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        stopTor();
        updateState(STATUS.ERROR, 'Startup timed out');
        setStatusMessage('tor', 'Tor failed to start');
      }
    }
  }, 1000);
}

/** Stop Arti and restore direct connections. Resolves when the process exits. */
function stopTor() {
  return new Promise((resolve) => {
    pendingStart = false;

    const finish = () => {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      if (proxySession) clearOnionProxy(proxySession).catch(() => {});
      clearService('tor');
      artiBootstrapped = false;
      artiOutputBuffer = '';
      resolve();
    };

    if (!artiProcess) {
      updateState(STATUS.STOPPED);
      finish();
      return;
    }

    updateState(STATUS.STOPPING);
    if (healthCheckInterval) clearInterval(healthCheckInterval);

    artiProcess.once('close', finish);

    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (artiProcess) {
        log.warn('[Tor] Force killing arti...');
        artiProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 10000);

    artiProcess.kill('SIGTERM');
  });
}

function getActivePort() {
  return currentSocksPort;
}

function registerTorIpc() {
  log.info('[Tor] Registering IPC handlers');
  const torDisabledResponse = {
    status: STATUS.STOPPED,
    error: 'Tor integration is disabled. Enable it in Settings > Experimental',
  };
  const isTorEnabled = () => loadSettings().enableTorIntegration === true;

  ipcMain.handle(IPC.TOR_START, () => {
    if (!isTorEnabled()) {
      log.info('[Tor] IPC: start blocked, integration disabled');
      return torDisabledResponse;
    }
    log.info('[Tor] IPC: start requested');
    startTor();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.TOR_STOP, () => {
    log.info('[Tor] IPC: stop requested');
    stopTor();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.TOR_GET_STATUS, () => {
    if (!isTorEnabled()) return torDisabledResponse;
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.TOR_CHECK_BINARY, () => {
    const available = checkBinary();
    log.info('[Tor] IPC: checkBinary requested, available:', available);
    return { available };
  });

  ipcMain.handle(IPC.TOR_GET_VERSION, async () => {
    if (!isTorEnabled()) {
      return failure(
        'TOR_DISABLED',
        'Tor integration is disabled. Enable it in Settings > Experimental'
      );
    }
    return getArtiVersion();
  });
}

module.exports = {
  registerTorIpc,
  startTor,
  stopTor,
  getActivePort,
  getArtiVersion,
  getArtiBinaryPath,
  getTorDataPath,
  writeArtiConfig,
  checkBinary,
  STATUS,
};
