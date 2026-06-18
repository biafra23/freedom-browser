const log = require('./logger');
const { app, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../shared/ipc-channels');
const { broadcastToAllWebContents } = require('./lib/broadcast-to-all-webcontents');

// Apply theme to nativeTheme so webviews get correct prefers-color-scheme
function applyNativeTheme(theme) {
  if (theme === 'light') {
    nativeTheme.themeSource = 'light';
  } else if (theme === 'dark') {
    nativeTheme.themeSource = 'dark';
  } else {
    nativeTheme.themeSource = 'system';
  }
}

const SETTINGS_FILE = 'settings.json';

// Bee-era settings keys renamed to their ant-named replacements. Migrated on
// load (for users upgrading from a bee-based build): the value is copied to the
// new key and the old key is dropped from the live file.
const RENAMED_KEYS = {
  beeNodeMode: 'antNodeMode',
  startBeeAtLaunch: 'startAntAtLaunch',
};

const DEFAULT_SETTINGS = {
  theme: 'system',
  enableRadicleIntegration: false,
  enableIdentityWallet: true,
  antNodeMode: 'ultraLight',
  startAntAtLaunch: true,
  startIpfsAtLaunch: true,
  startRadicleAtLaunch: false,
  autoUpdate: true,
  showBookmarkBar: false,
  // When true, navigating to an ENS name that resolved with trust.level =
  // 'unverified' is gated behind an interstitial with a single-use
  // "Continue once" option. ENS network config (resolution strategy, RPC
  // endpoints, prover, quorum params) lives in the network registry —
  // this is the one ENS-navigation setting kept here.
  blockUnverifiedEns: true,
  sidebarOpen: false,
  sidebarWidth: 320,
  // Linux only: render the tab strip as the window titlebar (frameless window).
  tabsInTitlebar: true,
};

let cachedSettings = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

// Rewrites bee-era keys to their ant-named replacements in place. Returns true
// when at least one key was migrated so the caller can persist the result.
function migrateRenamedKeys(parsed) {
  let migrated = false;
  for (const [oldKey, newKey] of Object.entries(RENAMED_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, oldKey)) continue;
    if (!Object.prototype.hasOwnProperty.call(parsed, newKey)) {
      parsed[newKey] = parsed[oldKey];
    }
    delete parsed[oldKey];
    migrated = true;
  }
  return migrated;
}

function loadSettings() {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    const filePath = getSettingsPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (migrateRenamedKeys(parsed)) {
        try {
          fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
        } catch (err) {
          log.error('Failed to persist migrated settings:', err);
        }
      }
      cachedSettings = { ...DEFAULT_SETTINGS, ...parsed };
    } else {
      cachedSettings = { ...DEFAULT_SETTINGS };
    }
  } catch (err) {
    log.error('Failed to load settings:', err);
    cachedSettings = { ...DEFAULT_SETTINGS };
  }

  // Apply theme to nativeTheme
  applyNativeTheme(cachedSettings.theme);

  return cachedSettings;
}

function broadcastSettingsUpdated(merged) {
  broadcastToAllWebContents(IPC.SETTINGS_UPDATED, merged);
}

// Walks DEFAULT_SETTINGS keys in one pass: drops unknown input keys (defense
// against a buggy or compromised internal page persisting junk to disk) and
// detects no-op saves at the same time. All settings are primitive-valued
// and compared by === .
function saveSettings(newSettings) {
  try {
    const previous = loadSettings();
    const merged = { ...previous };
    let changed = false;

    if (newSettings && typeof newSettings === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.prototype.hasOwnProperty.call(newSettings, key)) continue;

        if (previous[key] !== newSettings[key]) {
          merged[key] = newSettings[key];
          changed = true;
        }
      }
    }

    if (!changed) return true;

    const filePath = getSettingsPath();
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
    cachedSettings = merged;

    if (merged.theme !== previous.theme) {
      applyNativeTheme(merged.theme);
    }

    broadcastSettingsUpdated(merged);

    return true;
  } catch (err) {
    log.error('Failed to save settings:', err);
    return false;
  }
}

function registerSettingsIpc() {
  ipcMain.handle(IPC.SETTINGS_GET, () => {
    return loadSettings();
  });

  ipcMain.handle(IPC.SETTINGS_SAVE, (_event, newSettings) => {
    return saveSettings(newSettings);
  });
}

module.exports = {
  loadSettings,
  saveSettings,
  registerSettingsIpc,
};
