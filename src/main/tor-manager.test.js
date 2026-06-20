const fs = require('fs');
const os = require('os');
const path = require('path');
const IPC = require('../shared/ipc-channels');
const { createIpcMainMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function loadTorManager(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const enableTorIntegration = options.enableTorIntegration === true;
  const updateActiveProfileNodeConfig = options.updateActiveProfileNodeConfig || jest.fn();
  const promptForDefaultExternalCandidateProtocol =
    options.promptForDefaultExternalCandidateProtocol || jest.fn().mockResolvedValue([]);
  const defaultSession = options.defaultSession || {
    setProxy: jest.fn().mockResolvedValue(undefined),
  };
  const result = loadMainModule(require.resolve('./tor-manager'), {
    ipcMain,
    userDataDir: options.userDataDir,
    electronOverrides: {
      session: { defaultSession },
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
      [require.resolve('./profile-resolver')]: () => ({
        getActiveProfile: jest.fn(() => options.activeProfile || null),
        getReservedProfilePorts: jest.fn(() => options.reservedPorts || new Set()),
        updateActiveProfileNodeConfig,
      }),
      [require.resolve('./socks-probe')]: () => ({
        probeSocks5Endpoint: jest.fn().mockResolvedValue(options.socksProbeResult === true),
        probeTcpEndpoint: jest.fn().mockResolvedValue(options.tcpProbeResult ?? true),
      }),
      [require.resolve('./profile-external-candidates')]: () => ({
        promptForDefaultExternalCandidateProtocol,
      }),
      ...(options.extraMocks || {}),
    },
  });
  return {
    ...result,
    defaultSession,
  };
}

describe('tor-manager paths and config', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  test('getTorDataPath uses the active profile userData directory by default', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-profile-data-'));
    try {
      const { mod } = loadTorManager({ userDataDir });
      expect(mod.getTorDataPath()).toBe(path.join(userDataDir, 'tor-data'));
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
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
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return false;
      return realExistsSync(target);
    });
    const { mod } = loadTorManager();
    expect(mod.checkBinary()).toBe(false);
  });
});

describe('tor-manager IPC', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return false;
      return realExistsSync(target);
    });
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

  test('TOR_START prompts for a default external SOCKS endpoint before managed start', async () => {
    const ipcMain = createIpcMainMock();
    const activeProfile = {
      source: 'catalog',
      metadata: {
        nodes: {
          tor: {
            mode: 'managed',
            socksPort: 19150,
          },
        },
      },
    };
    const promptForDefaultExternalCandidateProtocol = jest.fn(async () => {
      activeProfile.metadata.nodes.tor = {
        mode: 'external',
        externalSocks: '127.0.0.1:9150',
      };
      return [
        {
          protocol: 'tor',
          choice: 'external',
          endpoints: ['SOCKS5 127.0.0.1:9150'],
        },
      ];
    });
    const { mod, defaultSession } = loadTorManager({
      ipcMain,
      enableTorIntegration: true,
      activeProfile,
      socksProbeResult: true,
      promptForDefaultExternalCandidateProtocol,
    });
    mod.registerTorIpc();

    await ipcMain.invoke(IPC.TOR_START);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(promptForDefaultExternalCandidateProtocol).toHaveBeenCalledWith(
      activeProfile,
      'tor',
      expect.objectContaining({ window: null })
    );
    expect(defaultSession.setProxy).toHaveBeenCalled();
    expect(mod.getActivePort()).toBe(9150);
    await mod.stopTor();
    await flushMicrotasks();
  });

  test('getArtiVersion fails when the binary is absent', async () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return false;
      return realExistsSync(target);
    });
    const { mod } = loadTorManager({ enableTorIntegration: true });
    const res = await mod.getArtiVersion();
    expect(res.success).toBe(false);
  });

  test('starts external Tor profile through a SOCKS endpoint without requiring arti', async () => {
    const targetSession = { setProxy: jest.fn().mockResolvedValue(undefined) };
    const { mod } = loadTorManager({
      enableTorIntegration: true,
      socksProbeResult: true,
      activeProfile: {
        metadata: {
          nodes: {
            tor: {
              mode: 'external',
              externalSocks: 'socks5://127.0.0.1:9150/',
            },
          },
        },
      },
    });

    await mod.startTor({ targetSession });

    expect(targetSession.setProxy).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'pac_script' })
    );
    expect(mod.getActivePort()).toBe(9150);
    await mod.stopTor();
  });
});
