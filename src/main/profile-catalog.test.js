const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getCatalogLockPaths,
  withCatalogWriteLock,
} = require('./profile-catalog');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-catalog-'));
}

function waitForPath(filePath, timeoutMs = 1000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function check() {
      if (fs.existsSync(filePath)) {
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${filePath}`));
        return;
      }

      setTimeout(check, 10);
    }

    check();
  });
}

function waitForExit(child, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for child lock holder'));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe('profile catalog', () => {
  let tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function track(dir) {
    tempDirs.push(dir);
    return dir;
  }

  test('waits briefly for a concurrent catalog writer', async () => {
    const appRoot = track(makeTempDir());
    const paths = getCatalogLockPaths(appRoot);
    const readyPath = path.join(appRoot, 'holder-ready');
    fs.writeFileSync(paths.targetPath, 'catalog lock target');

    const holderScript = `
      const lockfile = require(${JSON.stringify(require.resolve('proper-lockfile'))});
      const fs = require('fs');
      const targetPath = process.argv[1];
      const lockDir = process.argv[2];
      const readyPath = process.argv[3];
      const release = lockfile.lockSync(targetPath, {
        lockfilePath: lockDir,
        realpath: false,
        stale: 30000,
        update: 10000,
      });
      fs.writeFileSync(readyPath, 'ready');
      setTimeout(() => {
        release();
        process.exit(0);
      }, 150);
    `;

    const child = spawn(process.execPath, [
      '-e',
      holderScript,
      paths.targetPath,
      paths.lockDir,
      readyPath,
    ], {
      stdio: 'ignore',
    });
    let childExited = false;

    try {
      await waitForPath(readyPath);

      const result = withCatalogWriteLock(appRoot, () => 'acquired', {
        retries: { retries: 10, minTimeout: 25, maxTimeout: 25 },
      });

      expect(result).toBe('acquired');
      await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
      childExited = true;
    } finally {
      if (!childExited && !child.killed) {
        child.kill('SIGKILL');
      }
    }
  });
});
