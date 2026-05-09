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
  closeTab,
  switchTab,
  getOpenTabs,
} from './lib/tabs.js';
import { selectChainById } from './lib/wallet/chain-switcher.js';
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
import { initPageContextMenu, hidePageContextMenu } from './lib/page-context-menu.js';
import { pushDebug } from './lib/debug.js';
import { initOnboarding } from './lib/onboarding.js';
import { initSidebar } from './lib/sidebar.js';
import { initAiSidebar } from './lib/ai-sidebar.js';
import { initChatUi } from './lib/agent/chat-ui.js';
import { initAgentVaultUnlockHandler } from './lib/agent/vault-unlock-handler.js';
import { initSessionsUi } from './lib/agent/sessions-ui.js';
import { initChannelsUi } from './lib/agent/channels-ui.js';
import { initWalletUi, openPublishSetupFlow } from './lib/wallet-ui.js';

const electronAPI = window.electronAPI;

// Apply theme early to avoid flash
initTheme();

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

// Close all menus and context menus
const closeAllMenus = () => {
  closeMenus();
  hideTabContextMenu();
  hideBookmarkContextMenu();
  hidePageContextMenu();
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
  initTabs(); // Creates first tab and starts loading home page
  // Bridge for the agent's tab tools. The host renderer is the only
  // place that owns the tab list (each tab is a webview); main-side
  // tools call into this object via webContents.executeJavaScript.
  // Returns are kept JSON-serialisable — no DOM refs.
  //
  // Set as a plain `window.foo = …` rather than via `contextBridge`
  // because this is the privileged shell renderer (where the AI sidebar
  // lives), not a webview running untrusted page content. Webviews run
  // in separate web contents and can't reach this `window`.
  window.__agentTabBridge__ = {
    listTabs: () => getOpenTabs(),
    openTab: (url) => {
      const tab = createTab(url || null);
      return tab ? { id: tab.id, url: tab.url, title: tab.title } : null;
    },
    // closeTab/switchTab return true ONLY when the id matched a real
    // tab — main-side tools surface this to the model as
    // `{closed: false}` / `{switched: false}` for unknown ids so the
    // agent doesn't hallucinate success on a stale id.
    closeTab: (id) => {
      if (typeof id !== 'number') return false;
      const exists = getOpenTabs().some((t) => t.id === id);
      if (!exists) return false;
      closeTab(id);
      return true;
    },
    switchTab: (id) => {
      if (typeof id !== 'number') return false;
      const exists = getOpenTabs().some((t) => t.id === id);
      if (!exists) return false;
      switchTab(id);
      return true;
    },
  };

  // Wallet bridge — separate namespace from tab bridge because the
  // wallet surface will grow (chain switch now, sign/send next). Same
  // privileged-renderer assumption as __agentTabBridge__: webviews can't
  // reach this `window` because they run in separate web contents.
  window.__agentWalletBridge__ = {
    setActiveChain: (chainId) => {
      if (typeof chainId !== 'number') return false;
      selectChainById(chainId);
      return true;
    },
  };
  initAutocomplete(); // Address bar autocomplete
  initPageContextMenu(); // Page context menu for webviews
  initOnboarding();  // Identity onboarding wizard
  initSidebar();     // Identity & wallet sidebar
  initAiSidebar();   // Local AI chat sidebar
  initChatUi();      // Chat panel inside the AI sidebar
  initSessionsUi();  // Sessions list / master-detail swap
  initChannelsUi();  // XMTP channels list (master-detail, sibling to sessions)
  initWalletUi();    // Wallet & identity display in sidebar
  initAgentVaultUnlockHandler(); // Agent → main asks renderer to walk user through unlock
  loadBookmarks();
  initPlatformUI();
  initUpdateNotifications();
});
