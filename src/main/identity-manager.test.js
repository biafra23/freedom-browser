const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(),
  },
  ipcMain: {
    handle: jest.fn(),
  },
}));

const mockGetEthereumWalletIdentityReferences = jest.fn();

jest.mock('./swarm/feed-store', () => ({
  getEthereumWalletIdentityReferences: (...args) => mockGetEthereumWalletIdentityReferences(...args),
}));

const { deleteDerivedWallet } = require('./identity-manager');

describe('identity-manager wallet deletion', () => {
  let tmpDir;
  let previousIdentityDataDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manager-test-'));
    previousIdentityDataDir = process.env.FREEDOM_IDENTITY_DATA;
    process.env.FREEDOM_IDENTITY_DATA = tmpDir;
    mockGetEthereumWalletIdentityReferences.mockReturnValue([]);
  });

  afterEach(() => {
    if (previousIdentityDataDir === undefined) {
      delete process.env.FREEDOM_IDENTITY_DATA;
    } else {
      process.env.FREEDOM_IDENTITY_DATA = previousIdentityDataDir;
    }
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

    await expect(deleteDerivedWallet(2))
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

    await deleteDerivedWallet(2);

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
function createIdentityMock() {
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
    injectRadicleKey: jest.fn(() => 'did:key:zTest'),
    createRadicleIdentity: jest.fn(() => ({ did: 'did:key:zTest' })),
  };
}

function loadIdentityManager(dataDirs) {
  return loadMainModule(require.resolve('./identity-manager'), {
    extraMocks: {
      [require.resolve('./identity')]: () => createIdentityMock(),
    },
    userDataDir: dataDirs.identity,
  }).mod;
}

describe('injectAllIdentities restart reporting (issue #90)', () => {
  let root;
  let dataDirs;
  const savedEnv = {};
  const ENV_KEYS = [
    'FREEDOM_IDENTITY_DATA',
    'FREEDOM_BEE_DATA',
    'FREEDOM_IPFS_DATA',
    'FREEDOM_RADICLE_DATA',
  ];

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
    ENV_KEYS.forEach((key) => {
      savedEnv[key] = process.env[key];
    });
    process.env.FREEDOM_IDENTITY_DATA = dataDirs.identity;
    process.env.FREEDOM_BEE_DATA = dataDirs.bee;
    process.env.FREEDOM_IPFS_DATA = dataDirs.ipfs;
    process.env.FREEDOM_RADICLE_DATA = dataDirs.radicle;
  });

  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    });
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
});
