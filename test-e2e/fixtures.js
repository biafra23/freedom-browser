// Custom Playwright fixtures for the Freedom renderer E2E suite.
//
// `electronApp` launches the app from the repo root with FREEDOM_TEST_MODE=1
// and a per-run temp `userData` dir, so each test gets clean settings,
// bookmarks, and history. `window` is the first BrowserWindow page.
// `harness` exposes ergonomic helpers backed by the main-process test
// harness (see `src/main/test-harness.js`).

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');

// We want a stable settings shape across runs. The main-process settings
// store loads JSON from `<userData>/settings.json` and merges over
// DEFAULT_SETTINGS, so writing this file before app launch lets specs
// pick known initial values without going through the saveSettings IPC
// (which broadcasts events and would fight with the renderer's bootstrap).
function seedSettings(userDataDir, overrides) {
  if (!overrides) return;
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify(overrides, null, 2),
    'utf-8'
  );
}

const test = base.extend({
  // Explicit per-test option: seed settings.json before launch.
  // Useful when a spec needs to start from a non-default UI state
  // (e.g., bookmarks bar visible, theme=light) without the racing
  // problem above.
  seedSettings: [null, { option: true }],

  electronApp: async ({ seedSettings: settingsOverride }, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-e2e-'));
    seedSettings(userDataDir, settingsOverride);

    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: userDataDir,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        // Force a deterministic locale so menu accelerators don't drift
        // by region (CmdOrCtrl resolves to Cmd on darwin regardless).
        LANG: 'en_US.UTF-8',
      },
      timeout: 20_000,
    });

    await use(app);

    try {
      await app.close();
    } catch {
      // Window may already have been closed by the spec.
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — leftover dirs in /tmp are harmless.
    }
  },

  window: async ({ electronApp }, use) => {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    // Wait for chrome to mount before any spec interacts with it. The
    // address bar is the last toolbar element initialized; presence here
    // implies tab bar, bookmarks bar, and menus are all live.
    await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    await use(win);
  },

  // High-level helpers backed by the main-process test harness. Each
  // method round-trips through electronApp.evaluate() so it runs in the
  // main process where the harness state lives.
  harness: async ({ electronApp }, use) => {
    const setContentFixture = async (url, fixture) => {
      await electronApp.evaluate(({ ipcMain: _ipcMain }, { url: u, fixture: f }) => {
        globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(u, f);
      }, { url, fixture });
    };

    const setEnsFixture = async (name, result) => {
      await electronApp.evaluate(({ ipcMain: _ipcMain }, { name: n, result: r }) => {
        globalThis.__FREEDOM_TEST_HARNESS__.setEnsFixture(n, r);
      }, { name, result });
    };

    const setProbeFixture = async (hash, outcome) => {
      await electronApp.evaluate(({ ipcMain: _ipcMain }, { hash: h, outcome: o }) => {
        globalThis.__FREEDOM_TEST_HARNESS__.setProbeFixture(h, o);
      }, { hash, outcome });
    };

    const reset = async () => {
      await electronApp.evaluate(() => {
        globalThis.__FREEDOM_TEST_HARNESS__.resetFixtures();
      });
    };

    const state = async () => {
      return electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.state());
    };

    await use({ setContentFixture, setEnsFixture, setProbeFixture, reset, state });
  },
});

// Convenience: an arbitrary 64-char Swarm hex hash for fixture-driven
// `bzz://` navigation. Specs should treat this as opaque.
const SAMPLE_BZZ_HASH = 'a'.repeat(64);
const SAMPLE_IPFS_CID = 'bafybeib' + 'a'.repeat(51);

module.exports = {
  test,
  expect,
  SAMPLE_BZZ_HASH,
  SAMPLE_IPFS_CID,
};
