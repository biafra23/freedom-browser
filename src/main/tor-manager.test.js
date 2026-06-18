const fs = require('fs');
const os = require('os');
const path = require('path');
const IPC = require('../shared/ipc-channels');
const { createIpcMainMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function loadTorManager(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const enableTorIntegration = options.enableTorIntegration === true;
  return loadMainModule(require.resolve('./tor-manager'), {
    ipcMain,
    electronOverrides: {
      session: { defaultSession: { setProxy: jest.fn().mockResolvedValue(undefined) } },
    },
    extraMocks: {
      [require.resolve('./logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
      [require.resolve('./settings-store')]: () => ({
        loadSettings: () => ({ enableTorIntegration }),
      }),
    },
  });
}

describe('tor-manager paths and config', () => {
  test('getArtiBinaryPath points at the dev arti-bin layout', () => {
    const { mod } = loadTorManager();
    const expected = path.join(
      PROJECT_ROOT,
      'arti-bin',
      `${{ darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'arti.exe' : 'arti'
    );
    expect(mod.getArtiBinaryPath()).toBe(expected);
  });

  test('getTorDataPath honors FREEDOM_TOR_DATA override', () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-data-'));
    const prev = process.env.FREEDOM_TOR_DATA;
    process.env.FREEDOM_TOR_DATA = overrideDir;
    try {
      const { mod } = loadTorManager();
      expect(mod.getTorDataPath()).toBe(overrideDir);
    } finally {
      if (prev === undefined) delete process.env.FREEDOM_TOR_DATA;
      else process.env.FREEDOM_TOR_DATA = prev;
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  test('writeArtiConfig pins the SOCKS port and storage dirs', () => {
    const { mod } = loadTorManager();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-cfg-'));
    try {
      const configPath = mod.writeArtiConfig(dataDir, 9155);
      const toml = fs.readFileSync(configPath, 'utf-8');
      expect(toml).toContain('socks_listen = 9155');
      expect(toml).toContain('[storage]');
      expect(toml).toContain(JSON.stringify(path.join(dataDir, 'state')));
      expect(toml).toContain(JSON.stringify(path.join(dataDir, 'cache')));
      expect(fs.existsSync(path.join(dataDir, 'state'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'cache'))).toBe(true);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('checkBinary returns false when the arti binary is absent', () => {
    const { mod } = loadTorManager();
    // No arti-bin built in the test tree.
    expect(mod.checkBinary()).toBe(false);
  });
});

describe('tor-manager IPC', () => {
  test('TOR_GET_STATUS returns disabled response when integration is off', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadTorManager({ ipcMain, enableTorIntegration: false });
    mod.registerTorIpc();

    const res = await ipcMain.invoke(IPC.TOR_GET_STATUS);
    expect(res.status).toBe('stopped');
    expect(res.error).toMatch(/disabled/i);
  });

  test('TOR_START is blocked when integration is off', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadTorManager({ ipcMain, enableTorIntegration: false });
    mod.registerTorIpc();

    const res = await ipcMain.invoke(IPC.TOR_START);
    expect(res.status).toBe('stopped');
    expect(res.error).toMatch(/disabled/i);
  });

  test('TOR_CHECK_BINARY reports availability', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadTorManager({ ipcMain });
    mod.registerTorIpc();

    const res = await ipcMain.invoke(IPC.TOR_CHECK_BINARY);
    expect(res).toEqual({ available: false });
  });

  test('TOR_GET_VERSION is blocked when integration is off', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadTorManager({ ipcMain, enableTorIntegration: false });
    mod.registerTorIpc();

    const res = await ipcMain.invoke(IPC.TOR_GET_VERSION);
    expect(res.success).toBe(false);
    expect(res.error?.message || res.error).toMatch(/disabled/i);
  });

  test('getArtiVersion fails when the binary is absent', async () => {
    const { mod } = loadTorManager({ enableTorIntegration: true });
    const res = await mod.getArtiVersion();
    expect(res.success).toBe(false);
  });
});
