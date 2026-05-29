/**
 * Reproduction: Windows EPERM wiping bee-data/statestore (issue #90)
 *
 * When Bee is running it holds an open handle on the LevelDB `LOCK` file
 * inside `statestore`. The stale-dir wipe in `injectBeeIdentity()`
 * (src/main/identity-manager.js) calls `fs.rmSync(dir, { recursive: true })`
 * without `force`/`maxRetries`. On Windows that throws `EPERM` while the
 * handle is held; on POSIX the same call succeeds.
 *
 * This test simulates the held LevelDB lock with a plain open file handle
 * (no Bee binary required, so it runs on every platform/runner) and:
 *   1. Reproduces the failure: on Windows the bare recursive remove throws.
 *   2. Documents the safe behavior: once the lock is released (Bee stopped),
 *      a `force`/`maxRetries` remove succeeds.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Bee statestore wipe lock (issue #90)', () => {
  let tempDir;
  let statestoreDir;
  let lockFd = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-statestore-lock-'));
    statestoreDir = path.join(tempDir, 'statestore');
    fs.mkdirSync(statestoreDir, { recursive: true });

    // LevelDB layout: a LOCK file plus a data file.
    fs.writeFileSync(path.join(statestoreDir, 'LOCK'), '');
    fs.writeFileSync(path.join(statestoreDir, '000001.ldb'), 'leveldb-data');

    // Hold an open handle on LOCK to mimic a running Bee node.
    lockFd = fs.openSync(path.join(statestoreDir, 'LOCK'), 'r+');
  });

  afterEach(() => {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        // already closed
      }
      lockFd = null;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // The unguarded recursive remove (current injectBeeIdentity behavior) fails
  // on Windows while the LOCK handle is held — this is issue #90.
  const itReproduces = process.platform === 'win32' ? test : test.skip;
  itReproduces('bare recursive remove throws while the LOCK is held (Windows)', () => {
    expect(() => fs.rmSync(statestoreDir, { recursive: true })).toThrow(
      /EPERM|EBUSY|ENOTEMPTY/
    );
  });

  test('remove succeeds once the lock is released (Bee stopped)', () => {
    // Releasing the handle models Bee having fully exited before the wipe.
    fs.closeSync(lockFd);
    lockFd = null;

    expect(() =>
      fs.rmSync(statestoreDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
    ).not.toThrow();

    expect(fs.existsSync(statestoreDir)).toBe(false);
  });
});
