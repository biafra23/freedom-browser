const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

const ENV_KEYS = [
  'FREEDOM_BEE_DATA',
  'FREEDOM_IPFS_DATA',
  'FREEDOM_RADICLE_DATA',
  'FREEDOM_IDENTITY_DATA',
];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function makeProfileIdentityMock() {
  return {
    createVault: jest.fn().mockResolvedValue('test mnemonic'),
    unlockVault: jest.fn().mockResolvedValue(undefined),
    deriveAllKeys: jest.fn(() => ({
      userWallet: { address: '0xuser', privateKey: '0xuser-private' },
      beeWallet: { address: '0xbee', privateKey: '0xbee-private' },
      ipfsKey: { privateKey: Buffer.from('ipfs-private'), publicKey: Buffer.from('ipfs-public') },
      radicleKey: {
        privateKey: Buffer.from('radicle-private'),
        publicKey: Buffer.from('radicle-public'),
      },
    })),
    injectBeeKey: jest.fn().mockResolvedValue(undefined),
    createBeeConfig: jest.fn(),
    injectIpfsKey: jest.fn(() => '12D3KooProfilePeer'),
    injectRadicleKey: jest.fn(() => 'did:key:zProfileRadicle'),
  };
}

function makeRestartIdentityMock() {
  return {
    createVault: jest.fn(async () => 'test test test test test test test test test test test about'),
    unlockVault: jest.fn(async () => {}),
    deriveAllKeys: jest.fn(() => ({
      userWallet: { address: '0xuser', privateKey: '0x01' },
      beeWallet: { address: '0xbee', privateKey: '0x02' },
      ipfsKey: { privateKey: '0x03', publicKey: '0x04' },
      radicleKey: { privateKey: '0x05', publicKey: '0x06' },
    })),
    injectBeeKey: jest.fn(async () => {}),
    createBeeConfig: jest.fn(() => {}),
    injectIpfsKey: jest.fn(() => 'QmTestPeerId'),
    injectRadicleKey: jest.fn(() => 'did:key:zTest'),
  };
}

describe('identity-manager profile paths', () => {
  let tempDirs = [];
  let envSnapshot;

  beforeEach(() => {
    tempDirs = [];
    envSnapshot = snapshotEnv();
    restoreEnv(envSnapshot);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    for (const dir of tempDirs) {
      removeTempUserDataDir(dir);
    }
    jest.restoreAllMocks();
  });

  function tempDir(prefix) {
    const dir = createTempUserDataDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  test('injects node identities into env-resolved profile data dirs', async () => {
    const userDataDir = tempDir('identity-manager-user-data-');
    const identityDir = tempDir('identity-manager-identity-');
    const beeDir = tempDir('identity-manager-bee-');
    const ipfsDir = tempDir('identity-manager-ipfs-');
    const radicleDir = tempDir('identity-manager-radicle-');
    process.env.FREEDOM_IDENTITY_DATA = identityDir;
    process.env.FREEDOM_BEE_DATA = beeDir;
    process.env.FREEDOM_IPFS_DATA = ipfsDir;
    process.env.FREEDOM_RADICLE_DATA = radicleDir;

    fs.writeFileSync(path.join(ipfsDir, 'config'), '{}');

    const identityMock = makeProfileIdentityMock();
    const activeProfile = {
      id: 'profiled',
      source: 'catalog',
      metadata: {
        nodes: {
          bee: { apiPort: 11644, p2pPort: 12644 },
        },
      },
    };
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir,
      extraMocks: {
        [require.resolve('./identity')]: () => identityMock,
        [require.resolve('./profile-resolver')]: () => ({
          getActiveProfile: jest.fn(() => activeProfile),
        }),
      },
    });

    await mod.createNewVault('password123');
    await mod.injectBeeIdentity();
    await mod.injectIpfsIdentity();
    await mod.injectRadicleIdentity('ProfileAlias');

    expect(mod.getIdentityDataDir()).toBe(identityDir);
    expect(mod.getBeeDataDir()).toBe(beeDir);
    expect(mod.getIpfsDataDir()).toBe(ipfsDir);
    expect(mod.getRadicleDataDir()).toBe(radicleDir);

    expect(identityMock.injectBeeKey).toHaveBeenCalledWith(
      beeDir,
      '0xbee-private',
      expect.any(String)
    );
    expect(identityMock.createBeeConfig).toHaveBeenCalledWith(
      beeDir,
      expect.any(String),
      11644,
      12644
    );
    expect(identityMock.injectIpfsKey).toHaveBeenCalledWith(
      ipfsDir,
      Buffer.from('ipfs-private'),
      Buffer.from('ipfs-public')
    );
    expect(identityMock.injectRadicleKey).toHaveBeenCalledWith(
      radicleDir,
      Buffer.from('radicle-private'),
      Buffer.from('radicle-public'),
      'ProfileAlias'
    );
    expect(fs.existsSync(path.join(ipfsDir, '.identity-injected'))).toBe(true);
  });
});

describe('identity-manager wallet deletion', () => {
  let tmpDir;
  let envSnapshot;
  let mockGetEthereumWalletIdentityReferences;
  let identityManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manager-test-'));
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = tmpDir;
    mockGetEthereumWalletIdentityReferences = jest.fn(() => []);
    identityManager = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: tmpDir,
      extraMocks: {
        [require.resolve('./swarm/feed-store')]: () => ({
          getEthereumWalletIdentityReferences: (...args) =>
            mockGetEthereumWalletIdentityReferences(...args),
        }),
      },
    }).mod;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeVaultMeta(meta) {
    fs.writeFileSync(path.join(tmpDir, 'vault-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  }

  function readVaultMeta() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'vault-meta.json'), 'utf-8'));
  }

  test('blocks deleting wallets referenced by Swarm publisher identities', async () => {
    const references = [{
      origin: 'myapp.eth',
      identityId: 'ethereum-wallet:2',
      active: true,
      feedNames: ['blog'],
      feedCount: 1,
    }];
    mockGetEthereumWalletIdentityReferences.mockReturnValue(references);
    writeVaultMeta({
      activeWalletIndex: 2,
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0' },
        { index: 2, name: 'Trading Wallet', address: '0x2' },
      ],
    });

    await expect(identityManager.deleteDerivedWallet(2))
      .rejects.toMatchObject({
        code: 'SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE',
        references,
      });

    expect(mockGetEthereumWalletIdentityReferences).toHaveBeenCalledWith(2);
    expect(readVaultMeta().derivedWallets.map((wallet) => wallet.index)).toEqual([0, 2]);
    expect(readVaultMeta().activeWalletIndex).toBe(2);
  });

  test('deletes unreferenced derived wallet and resets active wallet', async () => {
    writeVaultMeta({
      activeWalletIndex: 2,
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0' },
        { index: 2, name: 'Trading Wallet', address: '0x2' },
      ],
    });

    await identityManager.deleteDerivedWallet(2);

    expect(mockGetEthereumWalletIdentityReferences).toHaveBeenCalledWith(2);
    expect(readVaultMeta().derivedWallets.map((wallet) => wallet.index)).toEqual([0]);
    expect(readVaultMeta().activeWalletIndex).toBe(0);
  });
});

describe('injectAllIdentities restart reporting (issue #90)', () => {
  let root;
  let dataDirs;
  let envSnapshot;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-mgr-'));
    dataDirs = {
      identity: path.join(root, 'identity'),
      bee: path.join(root, 'bee'),
      ipfs: path.join(root, 'ipfs'),
      radicle: path.join(root, 'radicle'),
    };
    for (const dir of Object.values(dataDirs)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = dataDirs.identity;
    process.env.FREEDOM_BEE_DATA = dataDirs.bee;
    process.env.FREEDOM_IPFS_DATA = dataDirs.ipfs;
    process.env.FREEDOM_RADICLE_DATA = dataDirs.radicle;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function loadIdentityManager(dataDirsForLoad) {
    return loadMainModule(require.resolve('./identity-manager'), {
      extraMocks: {
        [require.resolve('./identity')]: () => makeRestartIdentityMock(),
      },
      userDataDir: dataDirsForLoad.identity,
    }).mod;
  }

  function seedBeeInjected() {
    fs.mkdirSync(path.join(dataDirs.bee, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dataDirs.bee, 'keys', 'swarm.key'), '{}');
  }

  function seedIpfsConfig(withPeerId) {
    const config = withPeerId ? { Identity: { PeerID: 'QmExisting' } } : {};
    fs.writeFileSync(path.join(dataDirs.ipfs, 'config'), JSON.stringify(config));
  }

  function seedRadicleInjected() {
    fs.mkdirSync(path.join(dataDirs.radicle, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dataDirs.radicle, 'keys', 'radicle'), 'key');
  }

  test('force reinjection reports IPFS/Radicle but NOT Bee for restart', async () => {
    seedBeeInjected();
    seedIpfsConfig(true);
    seedRadicleInjected();

    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    const results = await mgr.injectAllIdentities('FreedomBrowser', true);

    expect(results.needsRestart).not.toContain('bee');
    expect(results.needsRestart).toEqual(expect.arrayContaining(['ipfs', 'radicle']));
    expect(results.bee.reinjected).toBe(true);
  });

  test('first-time injection reports nothing for restart', async () => {
    seedIpfsConfig(false);

    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    const results = await mgr.injectAllIdentities('FreedomBrowser', false);

    expect(results.needsRestart).toEqual([]);
  });
});
