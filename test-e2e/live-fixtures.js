// Custom fixtures for the live-network E2E suite.
//
// Unlike `fixtures.js`, this launches the app WITHOUT FREEDOM_TEST_MODE,
// so the actual Bee / IPFS managers start, ENS resolution hits the
// live Universal Resolver, and the production bzz:// / ipfs:// protocol
// handlers stream from the local gateway. We still pass
// FREEDOM_TEST_USER_DATA so the test session doesn't write to the
// user's real settings/bookmarks/history files.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');

// Mirror bee-manager.js's binary-path resolution so we can detect a
// missing binary up front and skip the suite gracefully (downloading
// the Bee binary is a per-platform extra step the user opts into via
// `npm run bee:download`).
function resolveBeeBinaryPath() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const arch = process.arch;
  const binName = process.platform === 'win32' ? 'bee.exe' : 'bee';
  return path.join(repoRoot, 'bee-bin', `${platform}-${arch}`, binName);
}

// Mirror ipfs-manager.js's binary-path resolution. Used by specs that
// hard-require IPFS so they can fail with a clear message instead of
// timing out on "Connected Peers" never updating.
function resolveIpfsBinaryPath() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const arch = process.arch;
  const binName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';
  return path.join(repoRoot, 'ipfs-bin', `${platform}-${arch}`, binName);
}

const BEE_BINARY_PATH = resolveBeeBinaryPath();
const HAS_BEE_BINARY = fs.existsSync(BEE_BINARY_PATH);

const IPFS_BINARY_PATH = resolveIpfsBinaryPath();
const HAS_IPFS_BINARY = fs.existsSync(IPFS_BINARY_PATH);

const test = base.extend({
  // Playwright derives fixture dependencies from the first parameter's
  // destructure; this fixture has none, but the empty `{}` is required
  // so Playwright recognises it as a fixture function rather than a
  // plain factory.
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-live-e2e-'));

    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        // Deliberately NOT setting FREEDOM_TEST_MODE — this suite needs
        // the production code paths (actual Bee spawn, live ENS, real
        // protocol handlers).
        FREEDOM_TEST_USER_DATA: userDataDir,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 60_000,
    });

    await use(app);

    try {
      await app.close();
    } catch {
      // Window may already be closed by the spec.
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; leftover dirs in /tmp are harmless.
    }
  },

  window: async ({ electronApp }, use) => {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    await use(win);
  },
});

module.exports = {
  test,
  expect,
  HAS_BEE_BINARY,
  BEE_BINARY_PATH,
  HAS_IPFS_BINARY,
  IPFS_BINARY_PATH,
};
