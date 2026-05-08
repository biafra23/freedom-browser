// Set app name early, before electron-log initializes (it uses app name for log path)
const { app } = require('electron');
const appName = process.platform === 'linux' ? 'freedom' : 'Freedom';

// Suppress Electron security warnings in development (CSP handles security in production)
if (!app.isPackaged) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

app.name = appName;
app.setName(appName);

// E2E test mode (Playwright). `FREEDOM_TEST_MODE=1` activates the
// fixture-driven harness in src/main/test-harness.js (stubbed protocols,
// no real Bee/IPFS spawn). `FREEDOM_TEST_USER_DATA` redirects userData
// to a per-run temp dir so each spec gets a clean settings/bookmarks/
// history store — honoured independently of FREEDOM_TEST_MODE so the
// live-network E2E suite can also opt into a clean userData without
// activating the harness. Both must be applied before any other module
// touches userData.
if (process.env.FREEDOM_TEST_USER_DATA) {
  app.setPath('userData', process.env.FREEDOM_TEST_USER_DATA);
}
const TEST_MODE = process.env.FREEDOM_TEST_MODE === '1';

const { version } = require('../../package.json');
const iconPath = app.isPackaged
  ? require('path').join(process.resourcesPath, 'assets', 'icon.png')
  : require('path').join(__dirname, '..', '..', 'assets', 'icon.png');

app.setAboutPanelOptions({
  applicationName: 'Freedom',
  applicationVersion: version,
  version: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
  copyright: '© 2025-2026 Freedom Team\nCopyleft — MPL-2.0',
  credits: 'A browser for the decentralized web\nSwarm · IPFS · ENS',
  website: 'https://freedombrowser.eth.limo/',
  iconPath,
});

const log = require('./logger');

// Global error handlers - must be set up early
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, _promise) => {
  log.error('Unhandled rejection:', reason);
});

const { BrowserWindow, protocol, session } = require('electron');
const path = require('path');
const { registerBaseIpcHandlers } = require('./ipc-handlers');
const { registerRequestRewriter } = require('./request-rewriter');
const { registerBzzProtocol } = require('./swarm/bzz-protocol');
const { registerIpfsProtocol, registerIpnsProtocol } = require('./ipfs/ipfs-protocol');

// Register `bzz:`, `ipfs:`, and `ipns:` as privileged standard schemes.
// Must run before `app.whenReady()` —
// see https://www.electronjs.org/docs/latest/api/protocol.
// See README "Swarm Content Retrieval" and "IPFS / IPNS Content Retrieval"
// for why these exist.
const DWEB_PROTOCOL_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
  allowServiceWorkers: true,
};
protocol.registerSchemesAsPrivileged([
  { scheme: 'bzz', privileges: DWEB_PROTOCOL_PRIVILEGES },
  { scheme: 'ipfs', privileges: DWEB_PROTOCOL_PRIVILEGES },
  { scheme: 'ipns', privileges: DWEB_PROTOCOL_PRIVILEGES },
]);
const { registerSettingsIpc, loadSettings } = require('./settings-store');
const { registerBookmarksIpc } = require('./bookmarks-store');
const { registerHistoryIpc, closeDb: closeHistoryDb } = require('./history');
const { registerFaviconsIpc } = require('./favicons');
const { registerEnsIpc } = require('./ens-resolver');
const { registerBeeIpc, stopBee, startBee, setUseInjectedIdentity: setBeeInjectedIdentity } = require('./bee-manager');
const { registerIpfsIpc, stopIpfs, startIpfs, setUseInjectedIdentity: setIpfsInjectedIdentity } = require('./ipfs-manager');
const { registerRadicleIpc, stopRadicle, startRadicle, setUseInjectedIdentity: setRadicleInjectedIdentity } = require('./radicle-manager');
const { registerIdentityIpc, hasVault } = require('./identity-manager');
const { registerQuickUnlockIpc } = require('./quick-unlock');
const { registerWalletIpc } = require('./wallet/wallet-ipc');
const { registerChainRegistryIpc } = require('./chain-registry');
const { registerRpcManagerIpc } = require('./wallet/rpc-manager');
const { registerDappPermissionsIpc } = require('./wallet/dapp-permissions');
const { registerSwarmIpc } = require('./swarm/stamp-service');
const { registerPublishIpc } = require('./swarm/publish-service');
const { registerPublishHistoryIpc, closeDb: closePublishHistoryDb } = require('./swarm/publish-history');
const { registerSwarmPermissionsIpc } = require('./swarm/swarm-permissions');
const { registerSwarmProviderIpc } = require('./swarm/swarm-provider-ipc');
const { registerFeedStoreIpc } = require('./swarm/feed-store');
const { registerGithubBridgeIpc, cleanupTempDirs } = require('./github-bridge');
const { registerServiceRegistryIpc } = require('./service-registry');
const { registerAgentIpc } = require('./agent/agent-ipc');
const { createMainWindow, setWindowTitle, getMainWindows } = require('./windows/mainWindow');
const { migrateUserData } = require('./migrate-user-data');
const { initUpdater } = require('./updater');
const { setupApplicationMenu, updateTabMenuItems } = require('./menu');
const { registerWebContentsHandlers } = require('./webcontents-setup');
const { installTestHarness } = require('./test-harness');

app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');

const crashDir = path.join(__dirname, 'crash-reports');
app.setPath('crashDumps', crashDir);

function allowInteractivePermissions(targetSession) {
  if (!targetSession || !targetSession.setPermissionRequestHandler) {
    return;
  }
  targetSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'pointerLock' || permission === 'fullscreen') {
      log.info(`[permissions] granting ${permission} for`, webContents.getURL());
      callback(true);
      return;
    }
    callback(false);
  });
}

async function bootstrap() {
  // Migrate user data from old "Freedom Browser" directory if needed
  // This must run before any modules access userData
  migrateUserData();

  const defaultSession = session.defaultSession;
  await defaultSession.clearCache();
  registerBaseIpcHandlers({
    onSetTitle: setWindowTitle,
    onNewWindow: createMainWindow,
  });
  registerSettingsIpc();
  registerBookmarksIpc();
  registerHistoryIpc();
  registerFaviconsIpc();
  registerEnsIpc();
  registerBeeIpc();
  registerIpfsIpc();
  registerRadicleIpc();
  registerGithubBridgeIpc();
  registerServiceRegistryIpc();
  registerIdentityIpc();
  registerQuickUnlockIpc();
  registerWalletIpc();
  registerChainRegistryIpc();
  registerRpcManagerIpc();
  registerDappPermissionsIpc();
  registerSwarmIpc();
  registerPublishIpc();
  registerPublishHistoryIpc();
  registerSwarmPermissionsIpc();
  registerSwarmProviderIpc();
  registerFeedStoreIpc();
  registerAgentIpc();
  if (!TEST_MODE) {
    // Skip registering the real bzz/ipfs/ipns handlers in test mode —
    // installTestHarness() registers fixture-driven stubs on the same
    // schemes below. Electron only allows one handler per scheme per
    // session, so the harness must own them outright in test mode.
    registerBzzProtocol(defaultSession);
    registerIpfsProtocol(defaultSession);
    registerIpnsProtocol(defaultSession);
  }
  registerRequestRewriter(defaultSession);
  allowInteractivePermissions(defaultSession);
  registerWebContentsHandlers();
  setupApplicationMenu();

  // Test harness is installed AFTER all production IPC + protocol
  // registrations, so it can override (via removeHandler + re-register)
  // the channels it needs to stub — ENS resolution, the bzz: probe,
  // and bee/ipfs/radicle start/stop. No-op when FREEDOM_TEST_MODE is
  // unset, so the production path is unaffected.
  installTestHarness({ defaultSession });

  // If a vault exists, flag the node managers so bee/ipfs/radicle start with
  // the user's derived keys. Without a vault, nodes start with their own
  // randomly-generated keys; users opt in to vault-backed identity later via
  // the wallet sidebar's "Get Started" flow, which re-keys and restarts them.
  try {
    if (await hasVault()) {
      log.info('[App] Identity vault found, enabling injected identity mode');
      setBeeInjectedIdentity(true);
      setIpfsInjectedIdentity(true);
      setRadicleInjectedIdentity(true);
    }
  } catch (err) {
    log.error('[App] Failed to check vault status:', err.message);
  }

  const settings = loadSettings();

  // In test mode the harness has already seeded service-registry with
  // fake endpoints. Spawning real Bee / IPFS / Radicle binaries against
  // a temp userData would fail port checks, take seconds, and defeat
  // the purpose of fixture-driven tests.
  if (!TEST_MODE) {
    if (settings.startBeeAtLaunch) {
      startBee();
    }
    if (settings.startIpfsAtLaunch) {
      startIpfs();
    }
    if (settings.enableRadicleIntegration && settings.startRadicleAtLaunch) {
      startRadicle();
    }
  }

  const mainWindow = createMainWindow();

  // Initialize auto-updater (pass menu update callback). Skipped in
  // test mode so specs don't trigger background network checks against
  // freedom.baby.
  if (!TEST_MODE) {
    initUpdater(mainWindow, setupApplicationMenu);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  updateTabMenuItems();
  if (process.platform !== 'darwin') {
    app.quit();
  }
  // Note: Bee is stopped in 'before-quit' handler, not here,
  // so it keeps running on macOS when all windows are closed
});

let isQuitting = false;

app.on('before-quit', async (event) => {
  if (isQuitting) return;

  event.preventDefault();
  isQuitting = true;

  // Close all DevTools first to prevent crashes during cleanup
  log.info('[App] Closing all DevTools...');
  for (const win of getMainWindows()) {
    try {
      win.webContents.send('devtools:close-all');
    } catch {
      // Window might already be closing
    }
  }

  // Small delay to allow DevTools to close
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Close all windows first, before winding down peers
  log.info('[App] Closing all windows...');
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length > 0) {
    await Promise.all(
      allWindows.map((win) => {
        return new Promise((resolve) => {
          if (win.isDestroyed()) {
            resolve();
            return;
          }
          win.once('closed', resolve);
          win.destroy();
        });
      })
    );
  }
  log.info('[App] All windows closed');

  // Close history databases
  log.info('[App] Closing history databases...');
  closeHistoryDb();
  closePublishHistoryDb();

  // Clean up any GitHub bridge temp directories
  cleanupTempDirs();

  log.info('[App] Waiting for Bee, IPFS, and Radicle to stop...');
  await Promise.all([stopBee(), stopIpfs(), stopRadicle()]);
  log.info('[App] All processes stopped, quitting...');


  app.quit();
});

app.on('browser-window-created', () => {
  updateTabMenuItems();
});
