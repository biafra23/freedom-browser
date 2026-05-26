// Renderer process entry point
import { updateRegistry, setRadicleIntegrationEnabled, setBlockUnverifiedEns } from './lib/state.js';
import { initBeeUi, updateBeeStatusLine, updateBeeToggleState } from './lib/bee-ui.js';
import { initIpfsUi, updateIpfsStatusLine, updateIpfsToggleState } from './lib/ipfs-ui.js';
import {
  initRadicleUi,
  updateRadicleStatusLine,
  updateRadicleToggleState,
} from './lib/radicle-ui.js';
import {
  initMenus,
  setOnOpenHistory,
  setOnNewTab,
  setOnMenuOpening,
  closeMenus,
} from './lib/menus.js';
import { initSettingsEffects, initTheme } from './lib/settings-ui.js';
import {
  initBookmarks,
  loadBookmarks,
  setOnLoadTarget,
  hideBookmarkContextMenu,
  setOnBookmarkContextMenuOpening,
} from './lib/bookmarks-ui.js';
import {
  initTabs,
  setLoadTargetHandler,
  setReloadHandler,
  setHardReloadHandler,
  hideTabContextMenu,
  setOnContextMenuOpening as setOnTabContextMenuOpening,
  createTab,
} from './lib/tabs.js';
import {
  initNavigation,
  loadTarget,
  reloadPage,
  hardReloadPage,
  onSettingsChanged,
  setOnHistoryRecorded,
  closeTrustPopover,
} from './lib/navigation.js';
import {
  initAutocomplete,
  setOnNavigate,
  refreshCache as refreshAutocompleteCache,
  hide as hideAutocomplete,
} from './lib/autocomplete.js';
import { initGithubBridgeUi, setOnOpenRadicleUrl } from './lib/github-bridge-ui.js';
import { initMenuBackdrop } from './lib/menu-backdrop.js';
import { initLinkStatus } from './lib/link-status.js';
import { initPageContextMenu, hidePageContextMenu } from './lib/page-context-menu.js';
import {
  initChromeInputContextMenu,
  hideChromeInputContextMenu,
} from './lib/chrome-input-context-menu.js';
import { pushDebug } from './lib/debug.js';
import { initOnboarding } from './lib/onboarding.js';
import { initSidebar } from './lib/sidebar.js';
import { initWalletUi, openPublishSetupFlow } from './lib/wallet-ui.js';

const electronAPI = window.electronAPI;

// Apply theme early to avoid flash
initTheme();

let closeProfileMenu = () => {};

// Listen for service registry updates from main process
window.serviceRegistry?.onUpdate?.((registry) => {
  pushDebug(`[ServiceRegistry] Update received: ${JSON.stringify(registry)}`);
  updateRegistry(registry);
  updateBeeStatusLine();
  updateBeeToggleState();
  updateIpfsStatusLine();
  updateIpfsToggleState();
  updateRadicleStatusLine();
  updateRadicleToggleState();
});

// Fetch initial registry state
window.serviceRegistry?.getRegistry?.().then((registry) => {
  if (registry) {
    pushDebug(`[ServiceRegistry] Initial state: ${JSON.stringify(registry)}`);
    updateRegistry(registry);
  }
});

// Wire up cross-module callbacks
initSettingsEffects(onSettingsChanged);
setOnLoadTarget(loadTarget);
setLoadTargetHandler(loadTarget);
setReloadHandler(reloadPage);
setHardReloadHandler(hardReloadPage);
setOnNavigate(loadTarget);
setOnHistoryRecorded(refreshAutocompleteCache);
setOnOpenHistory(() => loadTarget('freedom://history'));
setOnNewTab(() => createTab());
setOnOpenRadicleUrl((url) => loadTarget(url));
// When any popover/menu opens, dismiss other transient surfaces so we
// don't end up with the autocomplete dropdown or the ENS trust popover
// stacked on top of the nodes/main menu.
const onAnyMenuOpening = () => {
  hideAutocomplete();
  closeTrustPopover();
};
setOnMenuOpening(onAnyMenuOpening);
setOnTabContextMenuOpening(onAnyMenuOpening);
setOnBookmarkContextMenuOpening(onAnyMenuOpening);

// Initialize platform-specific UI adjustments
async function initPlatformUI() {
  const platform = await electronAPI.getPlatform();

  if (platform === 'linux') {
    document.body.classList.add('platform-linux');
  }
}

async function initProfileIndicator() {
  const indicator = document.getElementById('profile-indicator');
  const nameEl = document.getElementById('profile-indicator-name');
  const menu = document.getElementById('profile-menu');
  const menuName = document.getElementById('profile-menu-name');
  const menuMeta = document.getElementById('profile-menu-meta');
  const settingsBtn = document.getElementById('profile-settings-btn');
  if (!indicator || !nameEl) return;

  const setMenuOpen = (open) => {
    if (!menu) return;
    menu.hidden = !open;
    indicator.setAttribute('aria-expanded', String(open));
  };

  const openProfilesSettings = () => {
    setMenuOpen(false);
    loadTarget('freedom://settings/profiles');
  };

  closeProfileMenu = () => setMenuOpen(false);

  indicator.addEventListener('click', (event) => {
    event.stopPropagation();
    const shouldOpen = menu?.hidden !== false;
    closeAllMenus();
    setMenuOpen(shouldOpen);
  });

  settingsBtn?.addEventListener('click', openProfilesSettings);
  document.addEventListener('click', (event) => {
    if (
      menu?.hidden === false &&
      !menu.contains(event.target) &&
      !indicator.contains(event.target)
    ) {
      setMenuOpen(false);
    }
  });
  window.addEventListener('blur', () => setMenuOpen(false));

  try {
    const profile = await electronAPI.getActiveProfile?.();
    const label = profile?.displayName || profile?.id;
    if (!label) return;

    nameEl.textContent = label;
    indicator.title = profile?.isDev ? `${label} (dev)` : label;
    if (menuName) menuName.textContent = label;
    if (menuMeta) {
      const meta = [];
      if (profile?.isDev) meta.push('Development');
      if (profile?.source) meta.push(profile.source === 'catalog' ? 'Catalog profile' : profile.source);
      menuMeta.textContent = meta.join(' · ');
    }
    indicator.hidden = false;
  } catch (err) {
    pushDebug(`[profile] Failed to load active profile: ${err?.message || err}`);
  }
}

// Close all menus and context menus
const closeAllMenus = () => {
  closeMenus();
  closeProfileMenu();
  hideTabContextMenu();
  hideBookmarkContextMenu();
  hidePageContextMenu();
  hideChromeInputContextMenu();
};

// Close everything including autocomplete (used by backdrop)
const closeAllOverlays = () => {
  closeAllMenus();
  hideAutocomplete();
};

// Listen for close menus from main process (e.g., system menu clicked)
// Don't close autocomplete here - mirrors browser behavior where address bar stays open
electronAPI.onCloseMenus?.(closeAllMenus);

// Internal pages can deep-link into the sidebar publish-setup checklist.
electronAPI.onOpenPublishSetup?.(openPublishSetupFlow);

// Initialize update notification toast
function initUpdateNotifications() {
  const toast = document.getElementById('update-toast');
  const message = document.getElementById('update-toast-message');
  const actionBtn = document.getElementById('update-toast-action');
  const closeBtn = document.getElementById('update-toast-close');

  if (!toast || !message || !actionBtn || !closeBtn) return;

  let autoHideTimeout = null;

  const showToast = (text, showAction = false) => {
    message.textContent = text;
    actionBtn.hidden = !showAction;
    actionBtn.textContent = 'Install now';
    actionBtn.disabled = false;
    toast.hidden = false;

    // Clear any existing timeout
    if (autoHideTimeout) clearTimeout(autoHideTimeout);

    // Auto-hide after 8 seconds (unless action button is shown)
    if (!showAction) {
      autoHideTimeout = setTimeout(() => hideToast(), 8000);
    }
  };

  const hideToast = () => {
    toast.hidden = true;
  };

  closeBtn.addEventListener('click', hideToast);

  actionBtn.addEventListener('click', () => {
    actionBtn.textContent = 'Installing…';
    actionBtn.disabled = true;
    electronAPI.restartAndInstallUpdate?.();
  });

  // Listen for update notifications from main process
  electronAPI.onUpdateNotification?.((data) => {
    pushDebug(`[update] Received notification: ${data.type}`);
    if (data.type === 'ready') {
      showToast(data.message, true);
    } else {
      // checking, downloading, up-to-date
      showToast(data.message, false);
    }
  });
}

// Listen for open-url-new-tab custom event from context menu
document.addEventListener('open-url-new-tab', (e) => {
  const url = e.detail?.url;
  if (url) {
    createTab(url);
  }
});

// Initialize all modules
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const settings = await electronAPI.getSettings();
    setRadicleIntegrationEnabled(settings?.enableRadicleIntegration === true);
    setBlockUnverifiedEns(settings?.blockUnverifiedEns !== false);
  } catch {
    setRadicleIntegrationEnabled(false);
    setBlockUnverifiedEns(true);
  }
  window.addEventListener('settings:updated', (event) => {
    setRadicleIntegrationEnabled(event.detail?.enableRadicleIntegration === true);
    setBlockUnverifiedEns(event.detail?.blockUnverifiedEns !== false);
  });

  initMenuBackdrop(closeAllOverlays);
  initMenus();
  initBeeUi();
  initIpfsUi();
  initRadicleUi();
  initGithubBridgeUi();
  document.getElementById('settings-btn')?.addEventListener('click', () => {
    closeMenus();
    loadTarget('freedom://settings');
  });
  initBookmarks();
  initNavigation(); // Sets up event handler with tabs module
  initLinkStatus();
  initTabs(); // Creates first tab and starts loading home page
  initAutocomplete(); // Address bar autocomplete
  initPageContextMenu(); // Page context menu for webviews
  initChromeInputContextMenu({ onOpening: onAnyMenuOpening }); // Address bar edit menu
  initOnboarding();  // Identity onboarding wizard
  initSidebar();     // Identity & wallet sidebar
  initWalletUi();    // Wallet & identity display in sidebar
  loadBookmarks();
  initPlatformUI();
  initProfileIndicator();
  initUpdateNotifications();
});
