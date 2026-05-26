const fs = require('fs');
const path = require('path');
const {
  createAppMock,
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

describe('profile paths', () => {
  let tempDirs = [];
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    tempDirs.forEach(removeTempUserDataDir);
    tempDirs = [];
  });

  function track(dir) {
    tempDirs.push(dir);
    return dir;
  }

  function loadPaths(userDataDir) {
    const app = createAppMock({
      isPackaged: false,
      userDataDir,
    });
    return loadMainModule(require.resolve('./profile-paths'), { app }).mod;
  }

  test('resolves profile-owned directories under active userData', () => {
    const userDataDir = track(createTempUserDataDir());
    const paths = loadPaths(userDataDir);

    expect(paths.getIdentityDataDir()).toBe(path.join(userDataDir, 'identity'));
    expect(paths.getBeeDataDir()).toBe(path.join(userDataDir, 'bee-data'));
    expect(paths.getIpfsDataDir()).toBe(path.join(userDataDir, 'ipfs-data'));
    expect(paths.getRadicleDataDir()).toBe(path.join(userDataDir, 'radicle-data'));
    expect(paths.getProfileTempDir()).toBe(path.join(userDataDir, 'tmp'));
    expect(paths.getQuickUnlockCredentialPath()).toBe(
      path.join(userDataDir, 'identity', 'quick-unlock.dat')
    );

    expect(fs.existsSync(path.join(userDataDir, 'identity'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'tmp'))).toBe(true);
  });

  test('creates sanitized profile temp directories', () => {
    const userDataDir = track(createTempUserDataDir());
    const paths = loadPaths(userDataDir);

    const tempDir = paths.createProfileTempDir('github bridge!');

    expect(tempDir.startsWith(path.join(userDataDir, 'tmp', 'github-bridge-'))).toBe(true);
    expect(fs.existsSync(tempDir)).toBe(true);
  });

  test('honors explicit data directory overrides', () => {
    const userDataDir = track(createTempUserDataDir());
    const identityDir = track(createTempUserDataDir());
    const beeDir = track(createTempUserDataDir());
    const ipfsDir = track(createTempUserDataDir());
    const radicleDir = track(createTempUserDataDir());
    process.env.FREEDOM_IDENTITY_DATA = identityDir;
    process.env.FREEDOM_BEE_DATA = beeDir;
    process.env.FREEDOM_IPFS_DATA = ipfsDir;
    process.env.FREEDOM_RADICLE_DATA = radicleDir;

    const paths = loadPaths(userDataDir);

    expect(paths.getIdentityDataDir()).toBe(identityDir);
    expect(paths.getBeeDataDir()).toBe(beeDir);
    expect(paths.getIpfsDataDir()).toBe(ipfsDir);
    expect(paths.getRadicleDataDir()).toBe(radicleDir);
  });
});
