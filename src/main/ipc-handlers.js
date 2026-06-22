const crypto = require('crypto');
const fs = require('fs');
const log = require('./logger');
const { ipcMain, app, dialog, clipboard, nativeImage, webContents } = require('electron');
const { URL } = require('url');
const path = require('path');
const { activeBzzBases, activeRadBases } = require('./state');
const { loadSettings } = require('./settings-store');
const { fetchBuffer, fetchToFile } = require('./http-fetch');
const { success, failure, validateWebContentsId } = require('./ipc-contract');
const IPC = require('../shared/ipc-channels');
const { normalizeSocksEndpoint } = require('../shared/socks-endpoint');
const { startProbe: startSwarmProbe, cancelProbe: cancelSwarmProbe } = require('./swarm/swarm-probe');
const {
  createProfileForActiveApp,
  deleteProfileForActiveApp,
  getActiveProfile,
  importProfileForActiveApp,
  listProfilesForActiveApp,
  renameProfileForActiveApp,
  updateActiveProfileNodeConfig,
} = require('./profile-resolver');
const { launchProfile } = require('./profile-launcher');

// Bzz content probes, keyed by probe id. Each entry exposes a promise that
// resolves to the probe outcome. Entries survive until BZZ_AWAIT_PROBE
// consumes them (or a safety TTL elapses so abandoned entries don't leak).
//
// We *must not* drop entries the moment the probe settles: the renderer
// receives the id from BZZ_START_PROBE over IPC, then calls BZZ_AWAIT_PROBE
// in a second round-trip. Probes that resolve quickly (Bee already has the
// content, returns 200 on the first HEAD) would otherwise be deleted before
// the second call arrives, producing a spurious UNKNOWN_PROBE failure and
// dumping the user on the error page.
const bzzProbePromises = new Map();
const BZZ_PROBE_ABANDON_TTL_MS = 5 * 60 * 1000;

// Path to webview preload script (for internal pages)
const webviewPreloadPath = path.join(__dirname, 'webview-preload.js');

// Canonical internal-pages list (shared with preloads via sync IPC)
const internalPages = require('../shared/internal-pages.json');

// Ethereum provider injection source, read once and shared with webview preloads
// over sync IPC. The preload is sandboxed and cannot `require('fs')` itself.
const ethereumInjectSource = fs.readFileSync(
  path.join(__dirname, 'webview-preload-ethereum-inject.js'),
  'utf-8'
);

// EIP-6963 ProviderInfo static fields. Icon is a 96×96 PNG base64-encoded
// (spec recommends square, 96×96 minimum, and requires an RFC-2397 data URI).
// Name and rdns come from src/shared/brand.json. We cannot read them from
// package.json at runtime because electron-builder strips the `build` section
// (which holds productName and appId) from the packaged package.json.
const ethereumProviderIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'icon-6963.png')
  : path.join(__dirname, '..', '..', 'assets', 'icon-6963.png');
const brand = require('../shared/brand.json');
// Read the icon defensively: a missing/corrupt file must not block main-process
// startup. Fall back to an empty icon and let the 6963 announcement still fire.
let ethereumProviderIconDataUri = '';
try {
  ethereumProviderIconDataUri =
    'data:image/png;base64,' + fs.readFileSync(ethereumProviderIconPath, 'base64');
} catch (err) {
  log.error('[eip6963] Failed to load provider icon:', err.message);
}
const ethereumProviderInfoStatic = Object.freeze({
  name: brand.productName,
  icon: ethereumProviderIconDataUri,
  // rdns is EIP-6963's "reverse-DNS" identifier; brand.appId (baby.freedom.browser)
  // is already valid reverse-DNS of freedom.baby, so we reuse it.
  rdns: brand.appId,
});

const isAllowedBaseUrl = (value) => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
};

const formatWindowTitle = (title) => {
  return title?.trim() ? `${title.trim()} - Freedom` : 'Freedom';
};

function getIpcSenderUrl(event) {
  return event?.senderFrame?.url || event?.sender?.getURL?.() || '';
}

function normalizeFileUrlPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return null;
    return decodeURIComponent(parsed.pathname).replace(/\\/g, '/');
  } catch {
    return null;
  }
}

function isTrustedProfileMutationSender(event) {
  const pathname = normalizeFileUrlPath(getIpcSenderUrl(event));
  if (!pathname) return false;

  return pathname.endsWith('/src/renderer/index.html')
    || pathname.endsWith('/src/renderer/pages/settings.html');
}

function withTrustedProfileMutationSender(event, fn) {
  if (!isTrustedProfileMutationSender(event)) {
    return failure(
      'PROFILE_IPC_FORBIDDEN',
      'Profile changes are only available from trusted profile UI'
    );
  }
  return fn();
}

function serializeActiveProfile() {
  const profile = getActiveProfile();
  if (!profile) return null;

  const serialized = {
    id: profile.id,
    displayName: profile.displayName,
    source: profile.source,
    isDev: profile.isDev === true,
  };

  const metadata = profile.metadata || null;
  if (Number.isInteger(metadata?.slot)) {
    serialized.slot = metadata.slot;
  }
  if (metadata?.nodes && typeof metadata.nodes === 'object') {
    serialized.nodes = {
      bee: metadata.nodes.bee ? { ...metadata.nodes.bee } : null,
      ipfs: metadata.nodes.ipfs ? { ...metadata.nodes.ipfs } : null,
      radicle: metadata.nodes.radicle ? { ...metadata.nodes.radicle } : null,
      tor: metadata.nodes.tor ? { ...metadata.nodes.tor } : null,
    };
  }

  return serialized;
}

function broadcastProfileUpdated(profile = serializeActiveProfile()) {
  if (!webContents?.getAllWebContents) return;

  for (const contents of webContents.getAllWebContents()) {
    try {
      contents.send(IPC.PROFILE_UPDATED, profile);
    } catch {
      // The target may have been destroyed between enumeration and send.
    }
  }
}

function serializeProfileSummary(profile) {
  if (!profile) return null;
  const serialized = {
    id: profile.id,
    displayName: profile.displayName,
    slot: profile.slot,
    createdAt: profile.createdAt,
    lastOpenedAt: profile.lastOpenedAt,
    nodes: profile.nodes,
    isActive: profile.isActive === true,
  };
  if (profile.isUnregistered === true) {
    serialized.isUnregistered = true;
  }
  return serialized;
}

function serializeProfileMutationResult(result) {
  if (!result) return null;
  return serializeProfileSummary({
    id: result.metadata?.id || result.record?.id,
    displayName: result.metadata?.displayName || result.record?.displayName,
    slot: result.metadata?.slot ?? result.record?.slot,
    createdAt: result.metadata?.createdAt || result.record?.createdAt || null,
    lastOpenedAt: result.metadata?.lastOpenedAt || result.record?.lastOpenedAt || null,
    nodes: result.metadata?.nodes || result.record?.nodes || null,
    isActive: result.record?.id === getActiveProfile()?.id,
  });
}

const PROFILE_NODE_MODES = {
  bee: new Set(['managed', 'external', 'disabled']),
  ipfs: new Set(['managed', 'disabled']),
  radicle: new Set(['managed', 'external', 'disabled']),
  tor: new Set(['managed', 'external', 'disabled']),
};
const PROFILE_NODE_FIELDS = {
  bee: ['mode', 'externalApi'],
  ipfs: ['mode'],
  radicle: ['mode', 'externalHttp'],
  tor: ['mode', 'externalSocks'],
};
const EXTERNAL_FIELDS = {
  bee: ['externalApi'],
  radicle: ['externalHttp'],
  tor: ['externalSocks'],
};
const PROFILE_NODE_ENDPOINT_NORMALIZERS = {
  externalApi: normalizeProfileNodeEndpoint,
  externalHttp: normalizeProfileNodeEndpoint,
  externalSocks: normalizeSocksEndpoint,
};

function normalizeProfileNodeEndpoint(rawValue) {
  if (rawValue == null) return null;
  const trimmed = String(rawValue).trim();
  if (!trimmed) return null;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function validateProfileNodeConfigUpdate(protocol, patch = {}) {
  if (!Object.prototype.hasOwnProperty.call(PROFILE_NODE_FIELDS, protocol)) {
    return {
      ok: false,
      response: failure('INVALID_PROFILE_PROTOCOL', 'Unsupported profile node protocol', {
        protocol,
      }),
    };
  }

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return {
      ok: false,
      response: failure('INVALID_PROFILE_NODE_CONFIG', 'Profile node config must be an object'),
    };
  }

  const allowedFields = PROFILE_NODE_FIELDS[protocol];
  const sanitized = {};

  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;

    if (field === 'mode') {
      if (!PROFILE_NODE_MODES[protocol].has(patch.mode)) {
        return {
          ok: false,
          response: failure('INVALID_PROFILE_NODE_MODE', 'Unsupported profile node mode', {
            mode: patch.mode,
          }),
        };
      }
      sanitized.mode = patch.mode;
      continue;
    }

    const normalizeEndpoint = PROFILE_NODE_ENDPOINT_NORMALIZERS[field] || (() => null);
    const normalized = normalizeEndpoint(patch[field]);
    if (patch[field] && !normalized) {
      return {
        ok: false,
        response: failure('INVALID_PROFILE_NODE_ENDPOINT', 'Invalid profile node endpoint', {
          field,
        }),
      };
    }
    sanitized[field] = normalized;
  }

  if (!Object.keys(sanitized).length) {
    return {
      ok: false,
      response: failure('EMPTY_PROFILE_NODE_CONFIG', 'No supported profile node config fields'),
    };
  }

  if (sanitized.mode === 'external') {
    const missing = (EXTERNAL_FIELDS[protocol] || []).filter((field) => !sanitized[field]);
    if (missing.length) {
      return {
        ok: false,
        response: failure('MISSING_PROFILE_NODE_ENDPOINT', 'External node mode requires endpoints', {
          fields: missing,
        }),
      };
    }
  }

  return { ok: true, sanitized };
}

function updateProfileNodeConfigFromIpc(protocol, patch) {
  const activeProfile = getActiveProfile();
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return failure('PROFILE_NOT_EDITABLE', 'The active profile cannot be edited');
  }

  const validation = validateProfileNodeConfigUpdate(protocol, patch);
  if (!validation.ok) return validation.response;

  try {
    const result = updateActiveProfileNodeConfig(protocol, validation.sanitized);
    if (!result) {
      return failure('PROFILE_UPDATE_FAILED', 'Profile node config was not updated');
    }
    const profile = serializeActiveProfile();
    broadcastProfileUpdated(profile);
    return success({ profile });
  } catch (err) {
    log.error('[profile] Failed to update node config:', err);
    return failure('PROFILE_UPDATE_FAILED', err.message || 'Profile node config update failed');
  }
}

function listProfilesFromIpc() {
  const profiles = listProfilesForActiveApp();
  if (!profiles) {
    return failure('PROFILE_CATALOG_UNAVAILABLE', 'Profiles are not available for this launch mode');
  }
  return success({ profiles: profiles.map(serializeProfileSummary) });
}

function createProfileFromIpc(payload = {}) {
  try {
    const result = createProfileForActiveApp({
      displayName: payload.displayName,
      id: payload.id,
    });
    if (!result) {
      return failure('PROFILE_CATALOG_UNAVAILABLE', 'Profiles are not available for this launch mode');
    }
    return success({ profile: serializeProfileMutationResult(result) });
  } catch (err) {
    return failure('PROFILE_CREATE_FAILED', err.message || 'Profile could not be created');
  }
}

function importProfileFromIpc(payload = {}) {
  try {
    const result = importProfileForActiveApp(payload.id);
    if (!result) {
      return failure('PROFILE_CATALOG_UNAVAILABLE', 'Profiles are not available for this launch mode');
    }
    return success({ profile: serializeProfileMutationResult(result) });
  } catch (err) {
    return failure('PROFILE_IMPORT_FAILED', err.message || 'Profile could not be imported');
  }
}

function renameProfileFromIpc(payload = {}) {
  try {
    const result = renameProfileForActiveApp(payload.id, payload.displayName);
    if (!result) {
      return failure('PROFILE_CATALOG_UNAVAILABLE', 'Profiles are not available for this launch mode');
    }
    const activeProfile = serializeActiveProfile();
    broadcastProfileUpdated(activeProfile);
    return success({
      profile: serializeProfileMutationResult(result),
      activeProfile,
    });
  } catch (err) {
    return failure('PROFILE_RENAME_FAILED', err.message || 'Profile could not be renamed');
  }
}

function openProfileFromIpc(payload = {}) {
  const activeProfile = getActiveProfile();
  const profileId = payload.id;
  if (!profileId || typeof profileId !== 'string') {
    return failure('INVALID_PROFILE_ID', 'Missing profile id');
  }
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return failure('PROFILE_CATALOG_UNAVAILABLE', 'Profiles are not available for this launch mode');
  }
  if (profileId === activeProfile.id) {
    return failure('PROFILE_ALREADY_OPEN', 'This profile is already open');
  }

  const profiles = listProfilesForActiveApp();
  const target = profiles?.find((profile) => profile.id === profileId);
  if (!target) {
    return failure('PROFILE_NOT_FOUND', 'Profile not found', { id: profileId });
  }

  try {
    const launch = launchProfile(activeProfile, profileId);
    return success({
      profile: serializeProfileSummary(target),
      launch,
    });
  } catch (err) {
    log.error('[profile] Failed to open profile:', err);
    return failure('PROFILE_OPEN_FAILED', err.message || 'Profile could not be opened');
  }
}

function deleteProfileFromIpc(payload = {}) {
  try {
    const result = deleteProfileForActiveApp(payload.id, payload.confirmDisplayName);
    if (!result) {
      return failure('PROFILE_CATALOG_UNAVAILABLE', 'Profiles are not available for this launch mode');
    }
    return success({
      profile: serializeProfileSummary({
        id: result.record.id,
        displayName: result.record.displayName,
        slot: result.record.slot,
        createdAt: result.record.createdAt || null,
        lastOpenedAt: result.record.lastOpenedAt || null,
        nodes: result.record.nodes || null,
        isActive: false,
      }),
    });
  } catch (err) {
    return failure('PROFILE_DELETE_FAILED', err.message || 'Profile could not be deleted');
  }
}

function registerBaseIpcHandlers(callbacks = {}) {
  ipcMain.handle(IPC.BZZ_SET_BASE, (_event, payload = {}) => {
    const { webContentsId, baseUrl } = payload;
    if (!validateWebContentsId(webContentsId)) {
      return failure('INVALID_WEB_CONTENTS_ID', 'Invalid webContentsId', { webContentsId });
    }
    if (!baseUrl) {
      return failure('INVALID_BASE_URL', 'Missing baseUrl');
    }
    if (!isAllowedBaseUrl(baseUrl)) {
      log.warn('[ipc] Rejecting non-local bzz base URL');
      return failure('INVALID_BASE_URL', 'Base URL must be localhost or 127.0.0.1', { baseUrl });
    }
    try {
      const normalized = new URL(baseUrl);
      activeBzzBases.set(webContentsId, normalized);
      return success();
    } catch (err) {
      log.error('Invalid base URL received from renderer', err);
      return failure('INVALID_BASE_URL', 'Invalid baseUrl', { baseUrl });
    }
  });

  ipcMain.handle(IPC.BZZ_CLEAR_BASE, (_event, payload = {}) => {
    const { webContentsId } = payload;
    if (!validateWebContentsId(webContentsId)) {
      return failure('INVALID_WEB_CONTENTS_ID', 'Invalid webContentsId', { webContentsId });
    }
    activeBzzBases.delete(webContentsId);
    return success();
  });

  // Each probe is split across start/await/cancel so the renderer can
  // obtain the id before the probe settles (enabling mid-flight cancel
  // from the stop button / next navigation).
  ipcMain.handle(IPC.BZZ_START_PROBE, (_event, payload = {}) => {
    const { hash } = payload;
    if (typeof hash !== 'string' || !hash) {
      return failure('INVALID_HASH', 'Missing hash');
    }
    const { id, promise } = startSwarmProbe(hash);
    // Keep the entry until await-probe consumes it. A safety TTL drops
    // abandoned entries (e.g. the tab was closed before awaiting) without
    // racing the start→await IPC round-trip for fast-resolving probes.
    const timer = setTimeout(() => {
      bzzProbePromises.delete(id);
    }, BZZ_PROBE_ABANDON_TTL_MS);
    // Avoid keeping the Electron event loop alive solely for this cleanup.
    if (typeof timer.unref === 'function') timer.unref();
    bzzProbePromises.set(id, { promise, timer });
    return success({ id });
  });

  ipcMain.handle(IPC.BZZ_AWAIT_PROBE, async (_event, payload = {}) => {
    const { id } = payload;
    if (typeof id !== 'string' || !id) {
      return failure('INVALID_ID', 'Missing probe id');
    }
    const entry = bzzProbePromises.get(id);
    if (!entry) {
      return failure('UNKNOWN_PROBE', 'Unknown probe id', { id });
    }
    const outcome = await entry.promise;
    clearTimeout(entry.timer);
    bzzProbePromises.delete(id);
    return success({ outcome });
  });

  ipcMain.handle(IPC.BZZ_CANCEL_PROBE, (_event, payload = {}) => {
    const { id } = payload;
    if (typeof id !== 'string' || !id) {
      return failure('INVALID_ID', 'Missing probe id');
    }
    const cancelled = cancelSwarmProbe(id);
    return success({ cancelled });
  });

  ipcMain.handle(IPC.RAD_SET_BASE, (_event, payload = {}) => {
    const settings = loadSettings();
    if (!settings.enableRadicleIntegration) {
      return failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      );
    }
    const { webContentsId, baseUrl } = payload;
    if (!validateWebContentsId(webContentsId)) {
      return failure('INVALID_WEB_CONTENTS_ID', 'Invalid webContentsId', { webContentsId });
    }
    if (!baseUrl) {
      return failure('INVALID_BASE_URL', 'Missing baseUrl');
    }
    try {
      const normalized = new URL(baseUrl);
      activeRadBases.set(webContentsId, normalized);
      return success();
    } catch (err) {
      log.error('Invalid Radicle base URL received from renderer', err);
      return failure('INVALID_BASE_URL', 'Invalid baseUrl', { baseUrl });
    }
  });

  ipcMain.handle(IPC.RAD_CLEAR_BASE, (_event, payload = {}) => {
    const { webContentsId } = payload;
    if (!validateWebContentsId(webContentsId)) {
      return failure('INVALID_WEB_CONTENTS_ID', 'Invalid webContentsId', { webContentsId });
    }
    activeRadBases.delete(webContentsId);
    return success();
  });

  ipcMain.on(IPC.WINDOW_SET_TITLE, (event, title) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (!win) return;
    const formatted = formatWindowTitle(title);
    log.info(`[main] Setting window title to: "${formatted}" (requested: "${title}")`);
    win.setTitle(formatted);
    if (callbacks.onSetTitle) {
      callbacks.onSetTitle(formatted);
    }
  });

  ipcMain.on(IPC.WINDOW_CLOSE, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      win.close();
    }
  });

  ipcMain.on(IPC.WINDOW_MINIMIZE, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      win.minimize();
    }
  });

  ipcMain.on(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle(IPC.WINDOW_GET_PLATFORM, () => {
    return process.platform;
  });

  ipcMain.on(IPC.WINDOW_TOGGLE_FULLSCREEN, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  ipcMain.on(IPC.WINDOW_NEW, () => {
    if (callbacks.onNewWindow) {
      callbacks.onNewWindow();
    }
  });

  ipcMain.on(IPC.WINDOW_NEW_WITH_URL, (_event, url) => {
    if (callbacks.onNewWindow) {
      // Pass URL directly to createMainWindow to avoid home page flash
      callbacks.onNewWindow(url);
    }
  });

  ipcMain.on(IPC.APP_SHOW_ABOUT, () => {
    app.showAboutPanel();
  });

  ipcMain.handle(IPC.PROFILE_GET_ACTIVE, () => serializeActiveProfile());
  ipcMain.handle(IPC.PROFILE_LIST, () => listProfilesFromIpc());
  ipcMain.handle(IPC.PROFILE_CREATE, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => createProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_IMPORT, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => importProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_RENAME, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => renameProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_OPEN, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => openProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_DELETE, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => deleteProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_UPDATE_NODE_CONFIG, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () =>
      updateProfileNodeConfigFromIpc(payload.protocol, payload.config)
    )
  );

  ipcMain.handle(IPC.GET_WEBVIEW_PRELOAD_PATH, () => {
    return webviewPreloadPath;
  });

  // Sync handler: preloads use sendSync to get internal pages at load time
  ipcMain.on(IPC.GET_INTERNAL_PAGES, (event) => {
    event.returnValue = internalPages;
  });

  ipcMain.on(IPC.GET_ETHEREUM_INJECT_SOURCE, (event) => {
    // One UUID per webview-preload load (i.e. per page session), stable
    // across eip6963:requestProvider re-announcements within that session.
    // Each new tab / reload is a fresh session and gets a fresh UUID.
    // Escape '<' as \u003c so a future field value containing '</script>'
    // can't break out of the injected <script> tag (defense in depth;
    // today's fields all come from package.json).
    const info = { ...ethereumProviderInfoStatic, uuid: crypto.randomUUID() };
    const infoJson = JSON.stringify(info).replace(/</g, '\\u003c');
    const preamble = `window.__FREEDOM_PROVIDER_CONFIG__ = ${infoJson};\n`;
    event.returnValue = preamble + ethereumInjectSource;
  });

  ipcMain.handle(IPC.OPEN_URL_IN_NEW_TAB, (event, url) => {
    // Send to the main renderer to open in new tab
    // event.sender is the webview's webContents, hostWebContents is the main renderer
    const hostWebContents = event.sender.hostWebContents;
    if (hostWebContents) {
      hostWebContents.send('tab:new-with-url', url);
    }
  });

  ipcMain.handle(IPC.SIDEBAR_OPEN_PUBLISH_SETUP, (event) => {
    event.sender.hostWebContents?.send(IPC.SIDEBAR_OPEN_PUBLISH_SETUP);
  });

  ipcMain.handle(IPC.CONTEXT_MENU_SAVE_IMAGE, async (event, imageUrl) => {
    if (!imageUrl) {
      return { success: false, error: 'No image URL provided' };
    }

    try {
      // Get default filename from URL
      let defaultName = 'image';
      try {
        const urlObj = new URL(imageUrl);
        const pathname = urlObj.pathname;
        const lastSegment = pathname.split('/').pop();
        if (lastSegment && lastSegment.includes('.')) {
          defaultName = lastSegment;
        } else if (lastSegment) {
          defaultName = lastSegment;
        }
      } catch {
        // Use default
      }

      const win = event.sender.getOwnerBrowserWindow();
      const result = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      await fetchToFile(imageUrl, result.filePath);
      return { success: true, filePath: result.filePath };
    } catch (error) {
      log.error('[context-menu] Failed to save image:', error);
      return { success: false, error: error.message };
    }
  });

  // Copy text to clipboard
  ipcMain.handle('clipboard:copy-text', (_event, text) => {
    if (text) {
      clipboard.writeText(text);
      return { success: true };
    }
    return { success: false, error: 'No text provided' };
  });

  // Address-bar chrome context menu Paste fallback. Restricted to the
  // trusted main renderer: webviews (which expose `hostWebContents`)
  // could otherwise exfiltrate the user's clipboard without a paste
  // gesture by invoking this IPC directly through the exposed
  // electronAPI on a hostile page.
  ipcMain.handle('clipboard:read-text', (event) => {
    if (event?.sender?.hostWebContents) {
      return { success: false, error: 'Untrusted sender' };
    }
    return { success: true, text: clipboard.readText() };
  });

  // Copy image to clipboard
  ipcMain.handle('clipboard:copy-image', async (_event, imageUrl) => {
    if (!imageUrl) {
      return { success: false, error: 'No image URL provided' };
    }

    try {
      const imageData = await fetchBuffer(imageUrl);
      const image = nativeImage.createFromBuffer(imageData);

      if (image.isEmpty()) {
        return { success: false, error: 'Failed to create image from data' };
      }

      clipboard.writeImage(image);
      return { success: true };
    } catch (error) {
      log.error('[clipboard] Failed to copy image:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  broadcastProfileUpdated,
  createProfileFromIpc,
  deleteProfileFromIpc,
  importProfileFromIpc,
  isTrustedProfileMutationSender,
  listProfilesFromIpc,
  openProfileFromIpc,
  renameProfileFromIpc,
  registerBaseIpcHandlers,
  serializeActiveProfile,
  serializeProfileSummary,
  updateProfileNodeConfigFromIpc,
  validateProfileNodeConfigUpdate,
};
