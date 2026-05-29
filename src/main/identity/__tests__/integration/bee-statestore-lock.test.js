/**
 * Regression test for issue #90: Windows EPERM wiping bee-data/statestore.
 *
 * When Bee is running it holds an open handle on the LevelDB `LOCK` file
 * inside `statestore` (without FILE_SHARE_DELETE). The stale-dir wipe in
 * `injectBeeIdentity()` -> `removeStaleBeeDirs()` currently calls
 * `fs.rmSync(dir, { recursive: true })` with no `force`/`maxRetries`, which
 * throws `EPERM` on Windows while that handle is held.
 *
 * This test reproduces the failure WITHOUT a Bee binary: a separate child
 * process holds the `LOCK` open and releases it a moment later (modelling
 * Bee shutting down after a stop signal). The wipe must tolerate the briefly
 * held lock and complete.
 *
 * Expected status:
 *   - Today (bare recursive remove): FAILS on Windows (EPERM thrown
 *     immediately), passes on POSIX.
 *   - After the fix ({ force: true, maxRetries, retryDelay } in
 *     removeStaleBeeDirs, so the sync remove retries until the lock is
 *     released): passes on all platforms.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { removeStaleBeeDirs } = require('../../../identity-manager');

// How long the child holds the LOCK before releasing it. Must be shorter than
// the retry budget of the fixed removeStaleBeeDirs so retries can succeed.
const LOCK_HOLD_MS = 500;

function spawnLockHolder(lockPath) {
  const childSrc = `
    const fs = require('fs');
    const fd = fs.openSync(process.argv[1], 'r+');
    process.stdout.write('LOCKED\\n');
    setTimeout(() => { try { fs.closeSync(fd); } catch { /* gone */ } process.exit(0); }, ${LOCK_HOLD_MS});
  `;
  const child = spawn(process.execPath, ['-e', childSrc, lockPath], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock holder did not signal LOCKED')), 5000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('LOCKED')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });

  return { child, ready };
}

describe('Bee statestore wipe lock (issue #90)', () => {
  let tempDir;
  let statestoreDir;
  let holder = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-statestore-lock-'));
    statestoreDir = path.join(tempDir, 'statestore');
    fs.mkdirSync(statestoreDir, { recursive: true });

    // LevelDB layout: a LOCK file plus a data file.
    fs.writeFileSync(path.join(statestoreDir, 'LOCK'), '');
    fs.writeFileSync(path.join(statestoreDir, '000001.ldb'), 'leveldb-data');
  });

  afterEach(() => {
    if (holder && !holder.child.killed) {
      holder.child.kill('SIGKILL');
    }
    holder = null;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('wiping statestore succeeds while a node briefly holds the LOCK', async () => {
    holder = spawnLockHolder(path.join(statestoreDir, 'LOCK'));
    await holder.ready;

    // The lock is held right now; removeStaleBeeDirs must still complete.
    expect(() => removeStaleBeeDirs(tempDir)).not.toThrow();
    expect(fs.existsSync(statestoreDir)).toBe(false);
  }, 15000);
});
