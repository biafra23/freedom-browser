/**
 * Unit tests for injectAllIdentities restart reporting.
 *
 * Regression guard for issue #90: Bee's restart after (re)injection is owned by
 * injectBeeIdentity via the lifecycle hook (stop → wipe → start), so Bee must
 * NOT also be reported in `needsRestart` — otherwise the renderer restarts it a
 * second time. IPFS/Radicle have no lifecycle hook and must still be reported.
 *
 * The lazily-loaded `./identity` module is mocked so the test exercises the
 * orchestration/branch logic without real key derivation or node binaries.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

function createIdentityMock() {
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

  function seedIpfsConfig(withPeerId) {
    const config = withPeerId ? { Identity: { PeerID: 'QmExisting' } } : {};
    fs.writeFileSync(path.join(dataDirs.ipfs, 'config'), JSON.stringify(config));
  }

  function seedRadicleInjected() {
    fs.mkdirSync(path.join(dataDirs.radicle, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dataDirs.radicle, 'keys', 'radicle'), 'key');
  }

  test('force reinjection reports IPFS/Radicle but NOT Bee for restart', async () => {
    // All three already injected, so force=true takes the reinjection branch.
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
    // IPFS config exists but without a PeerID, so it is treated as not-yet
    // injected and no ipfs binary init is needed.
    seedIpfsConfig(false);

    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    const results = await mgr.injectAllIdentities('FreedomBrowser', false);

    expect(results.needsRestart).toEqual([]);
  });
});
