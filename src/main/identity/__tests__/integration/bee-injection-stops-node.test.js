/**
 * Regression test for the issue #90 follow-up: identity (re)injection must stop
 * a running Bee node before wiping its statestore.
 *
 * A real Bee node is started so it opens the LevelDB `statestore` and holds the
 * `LOCK`. The injection wipe (`wipeStaleBeeState`) is then run with a registered
 * Bee lifecycle stop hook — exactly as `index.js` wires it in production. The
 * wipe must invoke the stop hook (releasing the lock) and then remove
 * `statestore` cleanly.
 *
 * Expected status:
 *   - Without the fix (`wipeStaleBeeState` does not stop Bee first): the stop
 *     hook is never called — FAILS on every platform — and on Windows the wipe
 *     additionally throws EPERM because the LOCK is still held.
 *   - With the fix: the stop hook runs, Bee exits, and the wipe succeeds on all
 *     platforms.
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
const { setBeeLifecycle, wipeStaleBeeState } = require('../../../identity-manager');

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PORT = 11636;
// Pin a non-default p2p port so this node never clashes with the other
// Bee-spawning integration test when Jest runs test files in parallel.
const TEST_P2P_PORT = 11637;
const TEST_PASSWORD = 'test-password-for-injection-stop';

function getBeeBinaryPath() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'bee.exe' : 'bee';
  const projectRoot = path.resolve(__dirname, '../../../../..');
  const binPath = path.join(projectRoot, 'bee-bin', `${platform}-${process.arch}`, binName);
  return fs.existsSync(binPath) ? binPath : null;
}

function waitForBeeReady(port, stderrChunks = [], timeout = 90000) {
  const timeoutError = () => {
    const tail = stderrChunks.join('').split('\n').slice(-40).join('\n');
    return new Error(
      `Bee not ready after ${timeout}ms\n--- Bee stderr (last 40 lines) ---\n${tail}`
    );
  };
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
            reject(timeoutError());
          }
        }
      );
      req.on('error', () => {
        if (Date.now() - start < timeout) {
          setTimeout(check, 500);
        } else {
          reject(timeoutError());
        }
      });
      req.end();
    };
    check();
  });
}

function waitForExit(proc, timeout = 8000) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeout);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('Bee injection stops node before wipe (issue #90 follow-up)', () => {
  const beeBinary = getBeeBinaryPath();
  let tempDir;
  let beeProcess;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-injection-stop-'));
  });

  afterEach(async () => {
    setBeeLifecycle({});
    if (beeProcess && beeProcess.exitCode === null && !beeProcess.killed) {
      beeProcess.kill('SIGKILL');
      await waitForExit(beeProcess, 2000);
    }
    beeProcess = null;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  const maybeTest = beeBinary ? test : test.skip;

  maybeTest(
    'wipeStaleBeeState stops the running node, then removes statestore',
    async () => {
      const keys = deriveAllKeys(TEST_MNEMONIC);
      const configPath = createBeeConfig(tempDir, TEST_PASSWORD, TEST_PORT);
      fs.appendFileSync(configPath, `p2p-addr: 127.0.0.1:${TEST_P2P_PORT}\n`);
      // Pin a neighborhood so Bee doesn't query the external Swarmscan
      // suggester before going healthy — that lookup would make this required
      // CI job flaky on any DNS/service hiccup.
      fs.appendFileSync(configPath, 'target-neighborhood: "1"\n');
      await injectBeeKey(tempDir, keys.beeWallet.privateKey, TEST_PASSWORD);
      const stderrChunks = [];
      beeProcess = spawn(beeBinary, ['start', `--config=${configPath}`], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      beeProcess.stderr.on('data', (data) => stderrChunks.push(data.toString()));

      // Once healthy, Bee has opened statestore and holds the LevelDB LOCK.
      await waitForBeeReady(TEST_PORT, stderrChunks);
      expect(fs.existsSync(path.join(tempDir, 'statestore'))).toBe(true);

      // Wire a stop hook that tears down the running node, mirroring how
      // index.js wires bee-manager's stopBee. The wipe must call it.
      let stopCalled = false;
      setBeeLifecycle({
        stop: async () => {
          stopCalled = true;
          beeProcess.kill('SIGTERM');
          await waitForExit(beeProcess);
          return true;
        },
        start: async () => {},
      });

      const beeWasRunning = await wipeStaleBeeState(tempDir);

      // The node must have been stopped (lock released) and the wipe must have
      // succeeded — this is what was missing in the issue #90 follow-up.
      expect(stopCalled).toBe(true);
      expect(beeWasRunning).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'statestore'))).toBe(false);
    },
    120000
  );
});
