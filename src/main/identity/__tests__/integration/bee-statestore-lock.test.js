/**
 * Faithful regression test for issue #90: Windows EPERM wiping
 * bee-data/statestore.
 *
 * A real Bee node is started, which opens the LevelDB `statestore` and holds
 * its `LOCK` file the way it does in production. While that lock is held, the
 * stale-dir wipe used by `injectBeeIdentity()` (`removeStaleBeeDirs()`) is
 * invoked. A separate killer process terminates Bee shortly after, releasing
 * the lock.
 *
 * Expected status:
 *   - Today (bare `fs.rmSync(dir, { recursive: true })`): FAILS on Windows
 *     because the wipe throws EPERM immediately while Bee holds the LOCK.
 *     Passes on POSIX (the lock doesn't block unlink there).
 *   - After the fix (`{ force: true, maxRetries, retryDelay }`, so the sync
 *     remove retries until Bee has exited and the lock is released): passes on
 *     all platforms.
 *
 * Requires the Bee binary (run `npm run bee:download`); skipped if absent.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { deriveAllKeys } = require('../../derivation');
const { injectBeeKey, createBeeConfig } = require('../../injection');
const { removeStaleBeeDirs } = require('../../../identity-manager');

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PORT = 11633;
const TEST_PASSWORD = 'test-password-for-statestore-lock';

// How long after the wipe starts before Bee is force-killed (releasing the
// LOCK). Must be shorter than the retry budget of the fixed removeStaleBeeDirs.
const KILL_DELAY_MS = 300;

function getBeeBinaryPath() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'bee.exe' : 'bee';
  const projectRoot = path.resolve(__dirname, '../../../../..');
  const binPath = path.join(projectRoot, 'bee-bin', `${platform}-${process.arch}`, binName);
  return fs.existsSync(binPath) ? binPath : null;
}

function waitForBeeReady(port, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 },
        (res) => {
          if (res.statusCode === 200) {
            resolve(true);
          } else if (Date.now() - start < timeout) {
            setTimeout(check, 500);
          } else {
            reject(new Error(`Bee not ready after ${timeout}ms`));
          }
        }
      );
      req.on('error', () => {
        if (Date.now() - start < timeout) {
          setTimeout(check, 500);
        } else {
          reject(new Error(`Bee not ready after ${timeout}ms`));
        }
      });
      req.end();
    };
    check();
  });
}

// Kill a pid from a detached process. The main test thread blocks inside the
// synchronous removeStaleBeeDirs retry loop, so the lock holder must be torn
// down from a separate process whose event loop is unaffected.
function scheduleKill(pid, delayMs) {
  const src = `setTimeout(() => { try { process.kill(${pid}, 'SIGKILL'); } catch { /* gone */ } process.exit(0); }, ${delayMs});`;
  spawn(process.execPath, ['-e', src], { detached: true, stdio: 'ignore' }).unref();
}

describe('Bee statestore wipe lock (issue #90)', () => {
  const beeBinary = getBeeBinaryPath();
  let tempDir;
  let beeProcess;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-statestore-lock-'));
  });

  afterEach(async () => {
    if (beeProcess && !beeProcess.killed) {
      beeProcess.kill('SIGKILL');
      await new Promise((resolve) => {
        beeProcess.on('exit', resolve);
        setTimeout(resolve, 2000);
      });
    }
    beeProcess = null;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const maybeTest = beeBinary ? test : test.skip;

  maybeTest(
    'wiping statestore succeeds while a real Bee node holds the LOCK',
    async () => {
      const keys = deriveAllKeys(TEST_MNEMONIC);
      createBeeConfig(tempDir, TEST_PASSWORD, TEST_PORT);
      await injectBeeKey(tempDir, keys.beeWallet.privateKey, TEST_PASSWORD);

      const configPath = path.join(tempDir, 'config.yaml');
      beeProcess = spawn(beeBinary, ['start', `--config=${configPath}`], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      // Once Bee is healthy it has opened statestore and holds the LevelDB LOCK.
      await waitForBeeReady(TEST_PORT);
      expect(fs.existsSync(path.join(tempDir, 'statestore'))).toBe(true);

      // Release the lock shortly after, modelling Bee shutting down.
      scheduleKill(beeProcess.pid, KILL_DELAY_MS);

      // The wipe must tolerate the briefly-held lock (issue #90).
      expect(() => removeStaleBeeDirs(tempDir)).not.toThrow();
      expect(fs.existsSync(path.join(tempDir, 'statestore'))).toBe(false);
    },
    120000
  );
});
