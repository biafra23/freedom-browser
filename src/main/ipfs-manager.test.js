const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_USER_DATA_DIR = '/tmp/freedom-user-data';

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createProcessMock(binary, options = {}) {
  const listeners = new Map();
  const onceListeners = new Map();
  const stdoutListeners = new Map();
  const stderrListeners = new Map();

  const emitAll = (store, event, args) => {
    for (const handler of store.get(event) || []) {
      handler(...args);
    }
  };

  const proc = {
    binary,
    kills: [],
    stdout: {
      on: jest.fn((event, handler) => {
        if (!stdoutListeners.has(event)) {
          stdoutListeners.set(event, []);
        }
        stdoutListeners.get(event).push(handler);
      }),
    },
    stderr: {
      on: jest.fn((event, handler) => {
        if (!stderrListeners.has(event)) {
          stderrListeners.set(event, []);
        }
        stderrListeners.get(event).push(handler);
      }),
    },
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
    }),
    once: jest.fn((event, handler) => {
      if (!onceListeners.has(event)) {
        onceListeners.set(event, []);
      }
      onceListeners.get(event).push(handler);
    }),
    emit(event, ...args) {
      emitAll(listeners, event, args);
      const oneTimeHandlers = onceListeners.get(event) || [];
      onceListeners.delete(event);
      oneTimeHandlers.forEach((handler) => handler(...args));
    },
    emitStdout(data) {
      emitAll(stdoutListeners, 'data', [data]);
    },
    emitStderr(data) {
      emitAll(stderrListeners, 'data', [data]);
    },
    kill: jest.fn((signal) => {
      proc.kills.push(signal);
      if (options.autoCloseOnKill !== false) {
        proc.emit('close', options.closeCode ?? 0);
      }
      return true;
    }),
  };

  return proc;
}

function createSocketClass(portResolver) {
  const queue = Array.isArray(portResolver) ? [...portResolver] : null;

  return class MockSocket {
    constructor() {
      this.handlers = {};
    }

    setTimeout() {}

    on(event, handler) {
      this.handlers[event] = handler;
    }

    destroy() {}

    connect(port, host) {
      const result = typeof portResolver === 'function'
        ? portResolver(port, host)
        : queue && queue.length > 0
          ? queue.shift()
          : false;

      if (result === true) {
        this.handlers.connect?.();
        return;
      }

      if (result === 'timeout') {
        this.handlers.timeout?.();
        return;
      }

      this.handlers.error?.(new Error('closed'));
    }
  };
}

function createHttpRequestMock(responseResolver) {
  const resolveResponse = responseResolver || (() => ({ statusCode: 500, body: '' }));

  return jest.fn((options, callback) => {
    const requestHandlers = new Map();
    let timeoutHandler = null;

    const request = {
      on: jest.fn((event, handler) => {
        requestHandlers.set(event, handler);
        return request;
      }),
      setTimeout: jest.fn((_timeout, handler) => {
        timeoutHandler = handler;
        return request;
      }),
      destroy: jest.fn(),
      end: jest.fn(() => {
        const responseConfig = resolveResponse(options);

        if (responseConfig?.error) {
          requestHandlers.get('error')?.(responseConfig.error);
          return;
        }

        if (responseConfig?.timeoutEvent) {
          requestHandlers.get('timeout')?.();
          return;
        }

        if (responseConfig?.timeoutCallback) {
          timeoutHandler?.();
          return;
        }

        const responseHandlers = new Map();
        const response = {
          statusCode: responseConfig?.statusCode ?? 200,
          resume: jest.fn(),
          on: jest.fn((event, handler) => {
            if (!responseHandlers.has(event)) {
              responseHandlers.set(event, []);
            }
            responseHandlers.get(event).push(handler);
          }),
        };

        callback(response);

        const chunks = (() => {
          if (responseConfig?.body === undefined || responseConfig?.body === null) {
            return [];
          }
          if (typeof responseConfig.body === 'string') {
            return [responseConfig.body];
          }
          return [JSON.stringify(responseConfig.body)];
        })();

        chunks.forEach((chunk) => {
          for (const handler of responseHandlers.get('data') || []) {
            handler(chunk);
          }
        });
        for (const handler of responseHandlers.get('end') || []) {
          handler();
        }
      }),
    };

    return request;
  });
}

function createWindowMock() {
  return {
    webContents: {
      send: jest.fn(),
    },
  };
}

function loadIpfsManagerModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const app = options.app || createAppMock({
    isPackaged: options.isPackaged ?? false,
    userDataDir: options.userDataDir || DEFAULT_USER_DATA_DIR,
  });
  const windows = options.windows || [];
  const BrowserWindow = {
    getAllWindows: jest.fn(() => windows),
  };
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const updateService = jest.fn();
  const setStatusMessage = jest.fn();
  const setErrorState = jest.fn();
  const clearErrorState = jest.fn();
  const clearService = jest.fn();
  const spawnedProcesses = [];
  const execSync = options.execSync || jest.fn();
  const spawn = jest.fn((binary, args = [], spawnOptions = {}) => {
    const proc = (options.createProcess || createProcessMock)(binary, options.processOptions || {});
    proc.args = args;
    proc.spawnOptions = spawnOptions;
    spawnedProcesses.push(proc);
    return proc;
  });

  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const binaryName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';
  const binPath = path.join(PROJECT_ROOT, 'ipfs-bin', `${platform}-${process.arch}`, binaryName);
  const dataDir = path.join(options.userDataDir || DEFAULT_USER_DATA_DIR, 'ipfs-data');
  const configPath = path.join(dataDir, 'config');
  const lockPath = path.join(dataDir, 'repo.lock');

  const fsMock = {
    existsSync: jest.fn((target) => {
      if (typeof options.existsSync === 'function') {
        return options.existsSync(target);
      }

      if (target === binPath) return options.binExists !== false;
      if (target === dataDir) return options.dataDirExists === true;
      if (target === configPath) return options.configExists === true;
      if (target === lockPath) return options.lockExists === true;
      return false;
    }),
    mkdirSync: jest.fn(),
    unlinkSync: jest.fn(),
    readFileSync: jest.fn(() => options.configContents || '{}'),
    writeFileSync: jest.fn(),
  };

  const httpRequest = createHttpRequestMock(options.httpResponse);
  const Socket = createSocketClass(options.portSequence || options.portResolver || false);

  const { mod } = loadMainModule(require.resolve('./ipfs-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    extraMocks: {
      child_process: () => ({
        spawn,
        execSync,
      }),
      fs: () => fsMock,
      http: () => ({
        request: httpRequest,
      }),
      net: () => ({
        Socket,
      }),
      [require.resolve('./logger')]: () => log,
      [require.resolve('./profile-resolver')]: () => ({
        getActiveProfile: jest.fn(() => options.activeProfile || null),
      }),
      [require.resolve('./service-registry')]: () => ({
        MODE: {
          BUNDLED: 'bundled',
          REUSED: 'reused',
          EXTERNAL: 'external',
          DISABLED: 'disabled',
          NONE: 'none',
        },
        DEFAULTS: {
          ipfs: {
            apiPort: 5001,
            gatewayPort: 8080,
            fallbackRange: 10,
          },
        },
        updateService,
        setStatusMessage,
        setErrorState,
        clearErrorState,
        clearService,
      }),
    },
  });

  return {
    app,
    binPath,
    BrowserWindow,
    clearErrorState,
    clearService,
    configPath,
    dataDir,
    execSync,
    fsMock,
    httpRequest,
    ipcMain,
    lockPath,
    log,
    mod,
    setErrorState,
    setStatusMessage,
    spawn,
    spawnedProcesses,
    updateService,
    windows,
  };
}

describe('ipfs-manager', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('registers IPC handlers and reports binary availability plus initial status', async () => {
    const ctx = loadIpfsManagerModule({
      binExists: false,
    });

    ctx.mod.registerIpfsIpc();

    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual([
      IPC.IPFS_START,
      IPC.IPFS_STOP,
      IPC.IPFS_GET_STATUS,
      IPC.IPFS_CHECK_BINARY,
    ].sort());

    await expect(ctx.ipcMain.invoke(IPC.IPFS_GET_STATUS)).resolves.toEqual({
      status: 'stopped',
      error: null,
    });
    await expect(ctx.ipcMain.invoke(IPC.IPFS_CHECK_BINARY)).resolves.toEqual({
      available: false,
    });
  });

  test('reuses an existing daemon and clears the health-check interval on stop', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(321);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
    const window = createWindowMock();
    const ctx = loadIpfsManagerModule({
      windows: [window],
      portSequence: [true],
      httpResponse: (options) => {
        if (options.port === 5001) {
          return {
            statusCode: 200,
            body: { ID: 'peer-123' },
          };
        }

        return { statusCode: 500, body: '' };
      },
    });

    await ctx.mod.startIpfs();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBe(5001);
    expect(ctx.mod.getActiveGatewayPort()).toBe(8080);
    expect(ctx.updateService).toHaveBeenCalledWith('ipfs', {
      api: 'http://127.0.0.1:5001',
      gateway: 'http://localhost:8080',
      mode: 'reused',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Node: localhost:5001');
    expect(setIntervalSpy).toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.IPFS_STATUS_UPDATE, {
      status: 'starting',
      error: null,
    });
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.IPFS_STATUS_UPDATE, {
      status: 'running',
      error: null,
    });

    await ctx.mod.stopIpfs();

    expect(clearIntervalSpy).toHaveBeenCalledWith(321);
    expect(ctx.clearService).toHaveBeenCalledWith('ipfs');
  });

  test('starts a managed profile daemon on profile ports without reusing defaults', async () => {
    jest.useFakeTimers();
    const checkedPorts = [];
    const ctx = loadIpfsManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            ipfs: { mode: 'managed', apiPort: 15001, gatewayPort: 18080 },
          },
        },
      },
      configExists: true,
      portResolver: (port) => {
        checkedPorts.push(port);
        return false;
      },
      httpResponse: (options) => {
        if (options.port === 15001) {
          return {
            statusCode: 200,
            body: { ID: 'peer-15001' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startIpfs();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(checkedPorts).toContain(15001);
    expect(checkedPorts).toContain(18080);
    expect(checkedPorts).not.toContain(5001);
    expect(ctx.spawnedProcesses).toHaveLength(1);
    expect(ctx.mod.getActivePort()).toBe(15001);
    expect(ctx.mod.getActiveGatewayPort()).toBe(18080);
    expect(ctx.updateService).toHaveBeenCalledWith('ipfs', {
      api: 'http://127.0.0.1:15001',
      gateway: 'http://localhost:18080',
      mode: 'bundled',
    });

    const writtenConfig = JSON.parse(ctx.fsMock.writeFileSync.mock.calls[0][1]);
    expect(writtenConfig.Addresses.API).toBe('/ip4/127.0.0.1/tcp/15001');
    expect(writtenConfig.Addresses.Gateway).toBe('/ip4/127.0.0.1/tcp/18080');

    const stopPromise = ctx.mod.stopIpfs();
    await flushMicrotasks();
    await stopPromise;
  });

  test('connects to configured external profile endpoints without probing default ports', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(654);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
    const checkedPorts = [];
    const ctx = loadIpfsManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            ipfs: {
              mode: 'external',
              externalApi: ' http://127.0.0.1:25001/ ',
              externalGateway: ' http://localhost:28080/ ',
            },
          },
        },
      },
      portResolver: (port) => {
        checkedPorts.push(port);
        return true;
      },
      httpResponse: (options) => {
        if (options.port === 25001 && options.path === '/api/v0/id') {
          return {
            statusCode: 200,
            body: { ID: 'peer-external' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startIpfs();
    await flushMicrotasks();

    expect(checkedPorts).toEqual([]);
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBe(25001);
    expect(ctx.mod.getActiveGatewayPort()).toBe(28080);
    expect(ctx.updateService).toHaveBeenCalledWith('ipfs', {
      api: 'http://127.0.0.1:25001',
      gateway: 'http://localhost:28080',
      mode: 'external',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'External node: 127.0.0.1:25001');
    expect(setIntervalSpy).toHaveBeenCalled();

    await ctx.mod.stopIpfs();

    expect(clearIntervalSpy).toHaveBeenCalledWith(654);
    expect(ctx.clearService).toHaveBeenCalledWith('ipfs');
  });

  test('marks a disabled profile IPFS node without probing or spawning', async () => {
    const checkedPorts = [];
    const ctx = loadIpfsManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            ipfs: { mode: 'disabled' },
          },
        },
      },
      portResolver: (port) => {
        checkedPorts.push(port);
        return true;
      },
    });

    await ctx.mod.startIpfs();
    await flushMicrotasks();

    expect(checkedPorts).toEqual([]);
    expect(ctx.httpRequest).not.toHaveBeenCalled();
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBeNull();
    expect(ctx.mod.getActiveGatewayPort()).toBeNull();
    expect(ctx.updateService).toHaveBeenCalledWith('ipfs', {
      api: null,
      gateway: null,
      mode: 'disabled',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Node disabled for this profile');
  });

  test('starts a bundled daemon on fallback ports, enforces config, and leaves no shutdown timers behind', async () => {
    jest.useFakeTimers();

    let configExists = false;
    const platformMap = {
      darwin: 'mac',
      linux: 'linux',
      win32: 'win',
    };
    const platform = platformMap[process.platform] || process.platform;
    const binaryName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';
    const binPath = path.join(PROJECT_ROOT, 'ipfs-bin', `${platform}-${process.arch}`, binaryName);
    const dataDir = path.join(DEFAULT_USER_DATA_DIR, 'ipfs-data');
    const lockPath = path.join(dataDir, 'repo.lock');
    const configPath = path.join(dataDir, 'config');
    const execSync = jest.fn(() => {
      configExists = true;
    });
    const ctx = loadIpfsManagerModule({
      execSync,
      lockExists: true,
      existsSync: (target) => {
        if (target === binPath) return true;
        if (target === dataDir) return false;
        if (target === lockPath) return true;
        if (target === configPath) return configExists;
        return false;
      },
      portSequence: [true, false, true, false],
      httpResponse: (options) => {
        if (options.port === 5001) {
          return {
            statusCode: 500,
            body: '',
          };
        }
        if (options.port === 5002) {
          return {
            statusCode: 200,
            body: { ID: 'peer-5002' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startIpfs();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(ctx.fsMock.mkdirSync).toHaveBeenCalledWith(ctx.dataDir, { recursive: true });
    expect(ctx.fsMock.unlinkSync).toHaveBeenCalledWith(ctx.lockPath);
    expect(execSync).toHaveBeenCalledWith(`"${ctx.binPath}" init`, {
      env: expect.objectContaining({
        IPFS_PATH: ctx.dataDir,
      }),
      stdio: 'pipe',
    });
    expect(ctx.spawnedProcesses).toHaveLength(1);
    expect(ctx.spawnedProcesses[0].binary).toBe(ctx.binPath);
    expect(ctx.spawnedProcesses[0].args).toEqual(['daemon']);
    expect(ctx.spawnedProcesses[0].spawnOptions).toEqual({
      env: expect.objectContaining({
        IPFS_PATH: ctx.dataDir,
      }),
    });
    expect(ctx.mod.getActivePort()).toBe(5002);
    expect(ctx.mod.getActiveGatewayPort()).toBe(8081);
    expect(ctx.updateService).toHaveBeenCalledWith('ipfs', {
      api: 'http://127.0.0.1:5002',
      gateway: 'http://localhost:8081',
      mode: 'bundled',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Fallback Port: 5002');

    const writtenConfig = JSON.parse(ctx.fsMock.writeFileSync.mock.calls[0][1]);
    expect(writtenConfig.Addresses.API).toBe('/ip4/127.0.0.1/tcp/5002');
    expect(writtenConfig.Addresses.Gateway).toBe('/ip4/127.0.0.1/tcp/8081');
    expect(writtenConfig.Routing.Type).toBe('autoclient');
    expect(writtenConfig.DNS.Resolvers).toEqual({
      '.': 'https://cloudflare-dns.com/dns-query',
      'eth.': 'https://dns.eth.limo/dns-query',
    });

    const stopPromise = ctx.mod.stopIpfs();
    await flushMicrotasks();
    await stopPromise;

    expect(ctx.spawnedProcesses[0].kills).toContain('SIGTERM');
    expect(ctx.clearService).toHaveBeenCalledWith('ipfs');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('fails startup when the IPFS binary is missing', async () => {
    const ctx = loadIpfsManagerModule({
      binExists: false,
      portSequence: [false],
      httpResponse: () => ({ statusCode: 500, body: '' }),
    });

    await ctx.mod.startIpfs();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Node failed to start');
    expect(ctx.log.error).not.toHaveBeenCalled();
  });

  test('fails startup when config enforcement cannot parse the repo config', async () => {
    const ctx = loadIpfsManagerModule({
      configExists: true,
      configContents: '{invalid json',
      portSequence: [false, false],
      httpResponse: (options) => {
        if (options.port === 5001) {
          return {
            statusCode: 500,
            body: '',
          };
        }
        return {
          statusCode: 200,
          body: { ID: 'peer' },
        };
      },
    });

    await ctx.mod.startIpfs();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Node failed to start');
    expect(ctx.log.error).toHaveBeenCalledWith(
      '[IPFS] Failed to enforce config:',
      expect.any(String)
    );
  });
});
