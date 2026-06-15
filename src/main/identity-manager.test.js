const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

const ENV_KEYS = [
  'FREEDOM_ANT_DATA',
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
    vaultExists: jest.fn(async () => true),
    isUnlocked: jest.fn(async () => true),
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
    createRadicleIdentity: jest.fn(() => ({ did: 'did:key:zTest' })),
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
    const antDir = tempDir('identity-manager-ant-');
    const ipfsDir = tempDir('identity-manager-ipfs-');
    const radicleDir = tempDir('identity-manager-radicle-');
    process.env.FREEDOM_IDENTITY_DATA = identityDir;
    process.env.FREEDOM_ANT_DATA = antDir;
    process.env.FREEDOM_IPFS_DATA = ipfsDir;
    process.env.FREEDOM_RADICLE_DATA = radicleDir;

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
    expect(mod.getAntDataDir()).toBe(antDir);
    expect(mod.getIpfsDataDir()).toBe(ipfsDir);
    expect(mod.getRadicleDataDir()).toBe(radicleDir);

    expect(identityMock.injectBeeKey).toHaveBeenCalledWith(
      antDir,
      '0xbee-private',
      expect.any(String)
    );
    expect(identityMock.createBeeConfig).toHaveBeenCalledWith(
      antDir,
      expect.any(String),
      11644,
      12644
    );
    expect(identityMock.injectIpfsKey).not.toHaveBeenCalled();
    expect(identityMock.injectRadicleKey).toHaveBeenCalledWith(
      radicleDir,
      Buffer.from('radicle-private'),
      Buffer.from('radicle-public'),
      'ProfileAlias'
    );
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

/**
 * Regression guard for issue #90: Bee's restart after (re)injection is owned by
 * injectBeeIdentity via the lifecycle hook (stop → wipe → start), so Bee must
 * NOT also be reported in `needsRestart` — otherwise the renderer restarts it a
 * second time. Radicle has no lifecycle hook and must still be reported. Native
 * IPFS uses ephemeral identities for retrieval today, so it must not report a
 * restart or a durable injected identity.
 *
 * The lazily-loaded `./identity` module is mocked so the test exercises the
 * orchestration/branch logic without real key derivation or node binaries.
 */
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
    process.env.FREEDOM_ANT_DATA = dataDirs.bee;
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

  function seedIpfsIdentityMetadata() {
    fs.writeFileSync(
      path.join(dataDirs.identity, 'ipfs-identity.json'),
      JSON.stringify({ peerId: 'QmExisting', activeWithNativeNode: false }, null, 2)
    );
  }

  function seedRadicleInjected() {
    fs.mkdirSync(path.join(dataDirs.radicle, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dataDirs.radicle, 'keys', 'radicle'), 'key');
  }

  test('force reinjection reports Radicle but NOT Bee/IPFS for restart', async () => {
    // Bee/Radicle are injected. A stale IPFS identity metadata file from older
    // builds must be ignored because native freedom-ipfs now reports ephemeral
    // identity mode instead of a prepared durable PeerID.
    seedBeeInjected();
    seedIpfsIdentityMetadata();
    seedRadicleInjected();

    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    const results = await mgr.injectAllIdentities('FreedomBrowser', true);

    expect(results.needsRestart).not.toContain('bee');
    expect(results.needsRestart).not.toContain('ipfs');
    expect(results.needsRestart).toEqual(expect.arrayContaining(['radicle']));
    expect(results.bee.reinjected).toBe(true);
    expect(results.ipfs).toMatchObject({
      mode: 'ephemeral',
      active: false,
      peerId: null,
      stableIdentitySupported: false,
    });
  });

  test('first-time injection reports nothing for restart', async () => {
    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    const results = await mgr.injectAllIdentities('FreedomBrowser', false);

    expect(results.needsRestart).toEqual([]);
    expect(results.ipfs).toMatchObject({
      mode: 'ephemeral',
      active: false,
      peerId: null,
      stableIdentitySupported: false,
    });
  });

  test('status reports native IPFS ephemeral identity mode', async () => {
    seedIpfsIdentityMetadata();

    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    await expect(mgr.getIdentityStatus()).resolves.toMatchObject({
      ipfsInjected: false,
      ipfsIdentityPrepared: false,
      ipfsIdentityMode: 'ephemeral',
      ipfsStableIdentitySupported: false,
      ipfsNativeIdentityActive: false,
      addresses: {
        ipfsPeerId: null,
      },
    });
  });

  // antd self-generates identity.json + signing.key when it starts on a data
  // dir without an injected keystore (e.g. auto-started at launch before the
  // vault was unlocked). If the wipe leaves those behind, antd keeps the
  // throwaway identity instead of the swarm.key we inject — running under the
  // wrong wallet (no stamps/chequebook). The wipe must remove them while
  // preserving the keystore that injection is about to (re)write.
  test('wipeStaleBeeState removes antd self-generated identity but keeps swarm.key', async () => {
    const beeDir = dataDirs.bee;
    fs.mkdirSync(path.join(beeDir, 'keys'), { recursive: true });
    fs.mkdirSync(path.join(beeDir, 'statestore'), { recursive: true });
    fs.writeFileSync(path.join(beeDir, 'statestore', 'CURRENT'), 'x');
    fs.writeFileSync(path.join(beeDir, 'identity.json'), '{"eth":"0xthrowaway"}');
    fs.writeFileSync(path.join(beeDir, 'signing.key'), 'throwaway');
    fs.writeFileSync(path.join(beeDir, 'keys', 'swarm.key'), '{}');
    fs.writeFileSync(path.join(beeDir, 'keys', 'libp2p_v2.key'), 'old');

    const mgr = loadIdentityManager(dataDirs);
    const beeWasRunning = await mgr.wipeStaleBeeState(beeDir);

    expect(beeWasRunning).toBe(false);
    expect(fs.existsSync(path.join(beeDir, 'identity.json'))).toBe(false);
    expect(fs.existsSync(path.join(beeDir, 'signing.key'))).toBe(false);
    expect(fs.existsSync(path.join(beeDir, 'statestore'))).toBe(false);
    expect(fs.existsSync(path.join(beeDir, 'keys', 'libp2p_v2.key'))).toBe(false);
    // The keystore is preserved — injection rewrites it immediately after.
    expect(fs.existsSync(path.join(beeDir, 'keys', 'swarm.key'))).toBe(true);
  });
});
