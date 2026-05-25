const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createAppMock,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');
const {
  getCheckoutId,
  getDevPortOffset,
  hashPath,
} = require('./profile-catalog');

function makeTempDir(prefix = 'freedom-profile-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRepoRoot() {
  const repoRoot = makeTempDir('freedom-repo-');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"freedom-browser"}');
  fs.mkdirSync(path.join(repoRoot, 'src', 'main'), { recursive: true });
  return repoRoot;
}

describe('profile resolver', () => {
  let tempDirs = [];

  afterEach(() => {
    tempDirs.forEach(removeTempUserDataDir);
    tempDirs = [];
  });

  function track(dir) {
    tempDirs.push(dir);
    return dir;
  }

  test('uses existing packaged userData as the default profile root', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { resolveProfile } = require('./profile-resolver');

    const profile = resolveProfile(app, {
      argv: ['electron', '.'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });

    expect(profile.id).toBe('default');
    expect(profile.userDataDir).toBe(userDataDir);
    expect(profile.appRoot).toBe(userDataDir);
    expect(fs.existsSync(path.join(userDataDir, 'profile-registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'profile.json'))).toBe(true);
    expect(profile.metadata.nodes.bee.apiPort).toBe(11633);
  });

  test('resolves named packaged profiles under Profiles and creates the default entry', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { resolveProfile } = require('./profile-resolver');

    const profile = resolveProfile(app, {
      argv: ['electron', '.', '--profile=work'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });

    expect(profile.id).toBe('work');
    expect(profile.userDataDir).toBe(path.join(userDataDir, 'Profiles', 'work'));
    expect(profile.metadata.nodes.bee.apiPort).toBe(11634);

    const catalog = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'profile-registry.json'), 'utf-8')
    );
    expect(catalog.profiles.map((entry) => entry.id)).toEqual(['default', 'work']);
  });

  test('uses FREEDOM_TEST_USER_DATA as the highest-precedence bypass', () => {
    const userDataDir = track(makeTempDir());
    const testUserData = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { initializeProfile } = require('./profile-resolver');

    const profile = initializeProfile(app, {
      argv: ['electron', '.', '--profile=work'],
      env: { FREEDOM_TEST_USER_DATA: testUserData },
    });

    expect(profile.source).toBe('test-user-data');
    expect(profile.userDataDir).toBe(testUserData);
    expect(app.setPath).toHaveBeenCalledWith('userData', testUserData);
    expect(app.setPath).toHaveBeenCalledWith(
      'crashDumps',
      path.join(testUserData, 'crash-reports')
    );
    expect(fs.existsSync(path.join(userDataDir, 'profile-registry.json'))).toBe(false);
  });

  test('resolves dev profiles under a checkout-scoped Freedom Dev home', () => {
    const appDataDir = track(makeTempDir());
    const repoRoot = track(makeRepoRoot());
    const app = createAppMock({
      isPackaged: false,
      appPaths: { appData: appDataDir },
    });
    const { resolveProfile } = require('./profile-resolver');

    const profile = resolveProfile(app, {
      argv: ['electron', '.'],
      env: {},
      repoRoot,
      now: '2026-05-25T00:00:00.000Z',
    });

    const checkoutHash = hashPath(fs.realpathSync(repoRoot));
    const appRoot = path.join(appDataDir, 'Freedom Dev', getCheckoutId(fs.realpathSync(repoRoot)));
    const offset = getDevPortOffset(checkoutHash);

    expect(profile.id).toBe('default');
    expect(profile.appRoot).toBe(appRoot);
    expect(profile.userDataDir).toBe(path.join(appRoot, 'Profiles', 'default'));
    expect(profile.metadata.nodes.bee.apiPort).toBe(21633 + offset);
  });

  test('uses FREEDOM_DEV_HOME as a full dev home override', () => {
    const appDataDir = track(makeTempDir());
    const devHome = track(makeTempDir());
    const repoRoot = track(makeRepoRoot());
    const app = createAppMock({
      isPackaged: false,
      appPaths: { appData: appDataDir },
    });
    const { resolveProfile } = require('./profile-resolver');

    const profile = resolveProfile(app, {
      argv: ['electron', '.', '--profile', 'work'],
      env: { FREEDOM_DEV_HOME: devHome },
      repoRoot,
      now: '2026-05-25T00:00:00.000Z',
    });

    expect(profile.appRoot).toBe(devHome);
    expect(profile.userDataDir).toBe(path.join(devHome, 'Profiles', 'work'));
  });

  test('rejects path-like profile ids', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { resolveProfile } = require('./profile-resolver');

    expect(() => resolveProfile(app, {
      argv: ['electron', '.', '--profile=../bad'],
      env: {},
    })).toThrow('Invalid profile id');
  });
});
