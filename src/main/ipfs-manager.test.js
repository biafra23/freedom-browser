const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DEV_IPFS_DATA_DIR = path.join(PROJECT_ROOT, 'ipfs-data', 'freedom-ipfs');

function createWindowMock() {
  return {
    webContents: {
      send: jest.fn(),
    },
  };
}

function loadIpfsManagerModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const app =
    options.app ||
    createAppMock({
      isPackaged: options.isPackaged ?? false,
      userDataDir: options.userDataDir || '/tmp/freedom-user-data',
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
  const fsMock = {
    mkdirSync: jest.fn(),
  };

  const nativeInstances = [];
  class MockFreedomIpfsNativeNode {
    constructor(config) {
      this.config = config;
      this.start = jest.fn(() => options.startOk !== false);
      this.stop = jest.fn(async () => {});
      this.request = jest.fn(async () => new Response('native-body', { status: 200 }));
      this.isHealthy = jest.fn(() => options.isHealthy !== false);
      this.progressSnapshotJson = jest.fn(() => '{"active":[],"events":[]}');
      this.nativeGatewayStatsJson = jest.fn(() => {
        if (options.statsThrows) throw new Error('stats unavailable');
        return '{"active_native_handles":0}';
      });
      nativeInstances.push(this);
    }

    static isAvailable() {
      return options.nativeAvailable !== false;
    }
  }

  const { mod } = loadMainModule(require.resolve('./ipfs-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    extraMocks: {
      fs: () => fsMock,
      [require.resolve('./logger')]: () => log,
      [require.resolve('./service-registry')]: () => ({
        MODE: {
          BUNDLED: 'bundled',
          NONE: 'none',
        },
        updateService,
        setStatusMessage,
        setErrorState,
        clearErrorState,
        clearService,
      }),
      [require.resolve('./ipfs/freedom-ipfs-native-node')]: () => ({
        FreedomIpfsNativeNode: MockFreedomIpfsNativeNode,
      }),
    },
  });

  return {
    app,
    BrowserWindow,
    clearService,
    fsMock,
    ipcMain,
    log,
    mod,
    nativeInstances,
    setStatusMessage,
    setErrorState,
    clearErrorState,
    updateService,
    windows,
  };
}

describe('ipfs-manager', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('registers IPC handlers and reports native availability plus initial status', async () => {
    const ctx = loadIpfsManagerModule({
      nativeAvailable: false,
    });

    ctx.mod.registerIpfsIpc();

    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual(
      [IPC.IPFS_START, IPC.IPFS_STOP, IPC.IPFS_GET_STATUS, IPC.IPFS_CHECK_BINARY].sort()
    );

    await expect(ctx.ipcMain.invoke(IPC.IPFS_GET_STATUS)).resolves.toEqual({
      status: 'stopped',
      error: null,
      diagnostics: {
        progress: '{"active":[],"events":[]}',
        nativeGatewayStats: '{}',
      },
    });
    await expect(ctx.ipcMain.invoke(IPC.IPFS_CHECK_BINARY)).resolves.toEqual({
      available: false,
    });
  });

  test('starts the bundled freedom-ipfs native node', async () => {
    const window = createWindowMock();
    const ctx = loadIpfsManagerModule({ windows: [window] });

    await ctx.mod.startIpfs();

    expect(ctx.fsMock.mkdirSync).toHaveBeenCalledWith(DEV_IPFS_DATA_DIR, { recursive: true });
    expect(ctx.nativeInstances).toHaveLength(1);
    expect(ctx.nativeInstances[0].config).toEqual({
      dataDir: DEV_IPFS_DATA_DIR,
      onFailure: expect.any(Function),
    });
    expect(ctx.nativeInstances[0].start).toHaveBeenCalled();
    expect(ctx.updateService).toHaveBeenCalledWith('ipfs', {
      api: null,
      gateway: null,
      mode: 'bundled',
      backend: 'freedom-ipfs',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Node: freedom-ipfs');
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.IPFS_STATUS_UPDATE, {
      status: 'starting',
      error: null,
    });
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.IPFS_STATUS_UPDATE, {
      status: 'running',
      error: null,
    });
  });

  test('serves native gateway requests only while running', async () => {
    const ctx = loadIpfsManagerModule();

    const stoppedResponse = await ctx.mod.serveNativeGatewayRequest({
      path: '/ipfs/bafy',
      method: 'GET',
      headers: new Headers(),
    });
    expect(stoppedResponse.status).toBe(503);

    await ctx.mod.startIpfs();
    const response = await ctx.mod.serveNativeGatewayRequest({
      path: '/ipfs/bafy',
      method: 'GET',
      headers: new Headers(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('native-body');
    expect(ctx.nativeInstances[0].request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/ipfs/bafy',
      headers: expect.any(Headers),
      signal: undefined,
    });
  });

  test('stops the native node and clears registry state', async () => {
    const ctx = loadIpfsManagerModule();

    await ctx.mod.startIpfs();
    await ctx.mod.stopIpfs();

    expect(ctx.nativeInstances[0].stop).toHaveBeenCalled();
    expect(ctx.clearService).toHaveBeenCalledWith('ipfs');
    expect(ctx.clearErrorState).toHaveBeenCalledWith('ipfs');
  });

  test('moves to error and cleans up when the native node reports failure', async () => {
    const window = createWindowMock();
    const ctx = loadIpfsManagerModule({ windows: [window] });

    await ctx.mod.startIpfs();
    ctx.nativeInstances[0].config.onFailure('dispatcher died', ctx.nativeInstances[0]);
    await Promise.resolve();

    expect(ctx.nativeInstances[0].stop).toHaveBeenCalled();
    expect(ctx.clearService).toHaveBeenCalledWith('ipfs');
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Node unavailable');
    expect(ctx.setErrorState).toHaveBeenCalledWith(
      'ipfs',
      'Node unavailable. Restart IPFS from the nodes menu.'
    );
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.IPFS_STATUS_UPDATE, {
      status: 'error',
      error: 'dispatcher died',
    });

    const response = await ctx.mod.serveNativeGatewayRequest({
      path: '/ipfs/bafy',
      method: 'GET',
      headers: new Headers(),
    });
    expect(response.status).toBe(503);
  });

  test('health check reflects native liveness and diagnostics availability', async () => {
    const unhealthy = loadIpfsManagerModule({ isHealthy: false });
    await unhealthy.mod.startIpfs();
    expect(unhealthy.mod.checkHealth()).toBe(false);

    const throwingStats = loadIpfsManagerModule({ statsThrows: true });
    await throwingStats.mod.startIpfs();
    expect(throwingStats.mod.checkHealth()).toBe(false);
    expect(throwingStats.log.warn).toHaveBeenCalledWith(
      '[IPFS] Native health check failed:',
      'stats unavailable'
    );
  });

  test('fails startup when the native addon is unavailable', async () => {
    const ctx = loadIpfsManagerModule({
      nativeAvailable: false,
    });

    await ctx.mod.startIpfs();

    expect(ctx.nativeInstances).toHaveLength(0);
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Native node unavailable');
    await expect(
      ctx.mod.serveNativeGatewayRequest({
        path: '/ipfs/bafy',
        method: 'GET',
        headers: new Headers(),
      })
    ).resolves.toMatchObject({ status: 503 });
  });
});
