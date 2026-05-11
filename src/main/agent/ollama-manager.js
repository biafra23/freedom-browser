/**
 * Ollama Manager
 *
 * Lifecycle for the bundled Ollama sidecar — start/stop, port detection,
 * existing-daemon reuse, health monitoring, broadcast of status updates
 * to all renderers. Mirrors `bee-manager.js` / `ipfs-manager.js` shape so
 * the Nodes panel can surface Ollama with the same conventions.
 *
 * Ollama is simpler than Bee/IPFS: no config file, no key material, no
 * mainnet/light-node modes. We just spawn `ollama serve` with the right
 * env vars (`OLLAMA_HOST`, `OLLAMA_MODELS`, `OLLAMA_FLASH_ATTENTION`,
 * `OLLAMA_KV_CACHE_TYPE`) and poll `/api/version` for health.
 *
 * Models live under `app.getPath('cache')/freedom-models/` in packaged
 * builds and `./agent-models/` in dev — multi-GB blobs don't belong in
 * `userData`.
 */

const log = require('../logger');
const { ipcMain, app } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const IPC = require('../../shared/ipc-channels');
const {
  MODE,
  DEFAULTS,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('../service-registry');

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

// Server-side default context length passed via OLLAMA_CONTEXT_LENGTH.
// Ollama otherwise defaults to 4096 (the tiered VRAM-based defaults that
// shipped in 0.15.5+ only kick in for large CUDA setups), which silently
// truncates prompts the moment a Pi conversation grows past a few turns.
// Kept aligned with `DEFAULT_CONTEXT_WINDOW` in `pi-runtime.js`, which is
// what Pi advertises to the model registry — the two have to match or the
// LLM thinks it has 32K of room while Ollama is dropping the oldest 28K.
const DEFAULT_CONTEXT_LENGTH = 32768;

let currentState = STATUS.STOPPED;
let lastError = null;
let ollamaProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;

let currentApiPort = DEFAULTS.ollama.apiPort;
let currentMode = MODE.NONE;

function getOllamaBinaryPath() {
  const arch = process.arch;
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'ollama-bin')
    : path.join(__dirname, '..', '..', '..', 'ollama-bin', `${platform}-${arch}`);

  // Linux ships under bin/ollama, macOS/Windows put the binary at the top level.
  const binName = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const linuxBinPath = path.join(basePath, 'bin', binName);
  if (process.platform === 'linux' && fs.existsSync(linuxBinPath)) {
    return linuxBinPath;
  }
  return path.join(basePath, binName);
}

function getOllamaModelsPath() {
  if (process.env.OLLAMA_MODELS) {
    return process.env.OLLAMA_MODELS;
  }
  if (!app.isPackaged) {
    return path.join(__dirname, '..', '..', '..', 'agent-models');
  }
  const dir = path.join(app.getPath('cache'), 'freedom-models');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.OLLAMA_STATUS_UPDATE, {
      status: currentState,
      error: lastError,
    });
  }
}

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

function probeOllamaApi(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/version`, { timeout: 2000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ valid: typeof parsed.version === 'string', data: parsed });
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

async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.ollama.fallbackRange) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    const open = await isPortOpen(port);
    if (!open) return port;
    log.info(`[Ollama] Port ${port} is busy, trying next...`);
  }
  return null;
}

async function detectExistingDaemon() {
  const defaultPort = DEFAULTS.ollama.apiPort;
  const portOpen = await isPortOpen(defaultPort);
  if (!portOpen) return { found: false };

  const probe = await probeOllamaApi(defaultPort);
  if (probe.valid) {
    log.info('[Ollama] Found existing daemon on port', defaultPort);
    return { found: true, port: defaultPort, version: probe.data?.version };
  }

  log.info('[Ollama] Port', defaultPort, 'is busy (not Ollama)');
  return { found: false, conflict: true, port: defaultPort };
}

async function checkHealth() {
  const probe = await probeOllamaApi(currentApiPort);
  return probe.valid;
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
      setErrorState('ollama', 'Daemon unreachable. Retrying…');
    } else if (isHealthy && currentState === STATUS.ERROR) {
      clearErrorState('ollama');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

async function startOllama() {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[Ollama] Ignoring start request, current state: ${currentState}`);
    return;
  }
  if (currentState === STATUS.STOPPING) {
    log.info('[Ollama] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  pendingStart = false;
  updateState(STATUS.STARTING);

  const existing = await detectExistingDaemon();
  if (existing.found) {
    currentApiPort = existing.port;
    currentMode = MODE.REUSED;
    updateService('ollama', {
      api: `http://127.0.0.1:${currentApiPort}`,
      gateway: `http://127.0.0.1:${currentApiPort}`,
      mode: MODE.REUSED,
    });
    setStatusMessage('ollama', `Daemon: localhost:${currentApiPort}`);
    updateState(STATUS.RUNNING);
    startHealthCheck();
    log.info('[Ollama] Reusing existing daemon on port', currentApiPort);
    return;
  }

  const binPath = getOllamaBinaryPath();
  if (!fs.existsSync(binPath)) {
    updateState(STATUS.ERROR, `Ollama binary not found at ${binPath}`);
    setStatusMessage('ollama', 'Daemon failed to start');
    return;
  }

  let apiPort = DEFAULTS.ollama.apiPort;
  let usingFallbackPort = false;
  if (existing.conflict) {
    const newPort = await findAvailablePort(apiPort + 1);
    if (!newPort) {
      updateState(STATUS.ERROR, 'No available ports for Ollama');
      setStatusMessage('ollama', 'Daemon failed to start');
      return;
    }
    usingFallbackPort = true;
    apiPort = newPort;
  }

  currentApiPort = apiPort;
  currentMode = MODE.BUNDLED;

  const modelsDir = getOllamaModelsPath();
  const env = {
    ...process.env,
    OLLAMA_HOST: `127.0.0.1:${apiPort}`,
    OLLAMA_MODELS: modelsDir,
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_CONTEXT_LENGTH: String(DEFAULT_CONTEXT_LENGTH),
  };

  log.info(`[Ollama] Starting: ${binPath} serve (port ${apiPort}, models ${modelsDir})`);

  try {
    ollamaProcess = spawn(binPath, ['serve'], { env });

    ollamaProcess.stdout.on('data', (data) => {
      log.info(`[Ollama stdout]: ${data}`);
    });
    ollamaProcess.stderr.on('data', (data) => {
      // Ollama writes its routine startup logs to stderr; treat as info, not error.
      log.info(`[Ollama stderr]: ${data}`);
    });

    ollamaProcess.on('close', (code) => {
      log.info(`[Ollama] Process exited with code ${code}`);
      ollamaProcess = null;

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
      clearService('ollama');

      if (pendingStart) {
        log.info('[Ollama] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startOllama(), 100);
      }
    });

    ollamaProcess.on('error', (err) => {
      log.error('[Ollama] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('ollama', 'Daemon failed to start');
    });

    let attempts = 0;
    const maxAttempts = 30;
    const pollInterval = setInterval(async () => {
      if (currentState === STATUS.STOPPED || currentState === STATUS.ERROR) {
        clearInterval(pollInterval);
        return;
      }
      const isHealthy = await checkHealth();
      if (isHealthy) {
        clearInterval(pollInterval);
        updateService('ollama', {
          api: `http://127.0.0.1:${currentApiPort}`,
          gateway: `http://127.0.0.1:${currentApiPort}`,
          mode: MODE.BUNDLED,
        });
        if (usingFallbackPort) {
          setStatusMessage('ollama', `Fallback Port: ${currentApiPort}`);
        } else {
          setStatusMessage('ollama', null);
        }
        updateState(STATUS.RUNNING);
        startHealthCheck();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          stopOllama();
          updateState(STATUS.ERROR, 'Startup timed out');
          setStatusMessage('ollama', 'Daemon failed to start');
        }
      }
    }, 1000);
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ollama', 'Daemon failed to start');
  }
}

function stopOllama() {
  return new Promise((resolve) => {
    pendingStart = false;

    if (currentMode === MODE.REUSED) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('ollama');
      currentMode = MODE.NONE;
      resolve();
      return;
    }

    if (!ollamaProcess) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('ollama');
      resolve();
      return;
    }

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

    ollamaProcess.once('close', onExit);

    updateState(STATUS.STOPPING);
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    ollamaProcess.kill('SIGTERM');

    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (ollamaProcess) {
        log.warn('[Ollama] Force killing process...');
        ollamaProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 5000);
  });
}

function checkBinary() {
  return fs.existsSync(getOllamaBinaryPath());
}

function getActivePort() {
  return currentApiPort;
}

function registerOllamaIpc() {
  ipcMain.handle(IPC.OLLAMA_START, async () => {
    await startOllama();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.OLLAMA_STOP, async () => {
    await stopOllama();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.OLLAMA_GET_STATUS, () => {
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.OLLAMA_CHECK_BINARY, () => {
    return { available: checkBinary() };
  });
}

module.exports = {
  registerOllamaIpc,
  startOllama,
  stopOllama,
  getActivePort,
  getOllamaBinaryPath,
  getOllamaModelsPath,
  STATUS,
  DEFAULT_CONTEXT_LENGTH,
  // Exported for tests.
  _internals: {
    detectExistingDaemon,
    checkHealth,
    reset: () => {
      currentState = STATUS.STOPPED;
      lastError = null;
      ollamaProcess = null;
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      healthCheckInterval = null;
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      forceKillTimeout = null;
      pendingStart = false;
      currentApiPort = DEFAULTS.ollama.apiPort;
      currentMode = MODE.NONE;
    },
  },
};
