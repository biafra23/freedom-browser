const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acquireProfileLock,
  getProfileLockPaths,
  isLockUnavailableError,
  releaseProfileLock,
} = require('./profile-lock');

function makeTempProfile(id = 'default') {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-lock-'));
  return {
    id,
    displayName: id === 'default' ? 'Default' : id,
    userDataDir,
  };
}

describe('profile lock', () => {
  let tempDirs = [];
  let locks = [];

  afterEach(() => {
    locks.forEach((lock) => releaseProfileLock(lock));
    locks = [];
    tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    tempDirs = [];
  });

  function trackProfile(profile) {
    tempDirs.push(profile.userDataDir);
    return profile;
  }

  function trackLock(lock) {
    locks.push(lock);
    return lock;
  }

  test('prevents two processes from opening the same profile directory', () => {
    const profile = trackProfile(makeTempProfile());
    const firstLock = trackLock(acquireProfileLock(profile));
    const paths = getProfileLockPaths(profile);

    expect(fs.existsSync(paths.lockDir)).toBe(true);
    expect(() => acquireProfileLock(profile)).toThrow(expect.objectContaining({
      code: 'ELOCKED',
    }));

    releaseProfileLock(firstLock);
    expect(fs.existsSync(paths.lockDir)).toBe(false);

    const secondLock = trackLock(acquireProfileLock(profile));
    expect(fs.existsSync(secondLock.lockDir)).toBe(true);
  });

  test('allows different profile directories to be open at the same time', () => {
    const defaultProfile = trackProfile(makeTempProfile('default'));
    const workProfile = trackProfile(makeTempProfile('work'));

    const defaultLock = trackLock(acquireProfileLock(defaultProfile));
    const workLock = trackLock(acquireProfileLock(workProfile));

    expect(defaultLock.lockDir).not.toBe(workLock.lockDir);
    expect(fs.existsSync(defaultLock.lockDir)).toBe(true);
    expect(fs.existsSync(workLock.lockDir)).toBe(true);
  });

  test('recovers stale locks left behind by an unclean exit', () => {
    const profile = trackProfile(makeTempProfile());
    const paths = getProfileLockPaths(profile);
    fs.mkdirSync(profile.userDataDir, { recursive: true });
    fs.writeFileSync(paths.targetPath, 'stale target');
    fs.mkdirSync(paths.lockDir);
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(paths.lockDir, oldTime, oldTime);

    const lock = trackLock(acquireProfileLock(profile, {
      staleMs: 2000,
      updateMs: 1000,
    }));

    expect(lock.lockDir).toBe(paths.lockDir);
    expect(fs.existsSync(paths.lockDir)).toBe(true);
  });

  test('identifies lock-unavailable errors', () => {
    expect(isLockUnavailableError({ code: 'ELOCKED' })).toBe(true);
    expect(isLockUnavailableError({ code: 'ENOENT' })).toBe(false);
    expect(isLockUnavailableError(null)).toBe(false);
  });
});
