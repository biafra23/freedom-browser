const fs = require('fs');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

const originalEnv = {
  FREEDOM_BEE_DATA: process.env.FREEDOM_BEE_DATA,
  FREEDOM_IPFS_DATA: process.env.FREEDOM_IPFS_DATA,
  FREEDOM_RADICLE_DATA: process.env.FREEDOM_RADICLE_DATA,
  FREEDOM_IDENTITY_DATA: process.env.FREEDOM_IDENTITY_DATA,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function makeIdentityMock() {
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

describe('identity-manager profile paths', () => {
  let tempDirs = [];

  beforeEach(() => {
    tempDirs = [];
    restoreEnv();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv();
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

    const identityMock = makeIdentityMock();
    const identityModulePath = require.resolve('./identity');
    const activeProfile = {
      id: 'profiled',
      source: 'catalog',
      metadata: {
        nodes: {
          bee: { apiPort: 11644 },
        },
      },
    };
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir,
      extraMocks: {
        [identityModulePath]: () => identityMock,
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
      11644
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
