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
let externalNodeCandidatesHandler = null;
const queuedExternalNodeCandidatePayloads = [];

electronAPI.onExternalNodeCandidates?.((payload) => {
  if (externalNodeCandidatesHandler) {
    externalNodeCandidatesHandler(payload);
  } else {
    queuedExternalNodeCandidatePayloads.push(payload);
  }
});

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

function initExternalNodeCandidatesModal() {
  const modal = document.getElementById('external-node-candidates-modal');
  const list = document.getElementById('external-node-candidates-list');
  const submitBtn = document.getElementById('external-node-candidates-submit');
  const managedBtn = document.getElementById('external-node-candidates-managed');
  const closeBtn = document.getElementById('external-node-candidates-close');
  if (!modal || !list) return;

  let currentRequestId = null;
  let currentCandidates = [];
  let hasResponded = false;

  const closeModal = () => {
    if (modal.open && typeof modal.close === 'function') {
      modal.close();
    } else {
      modal.removeAttribute('open');
    }
  };

  const choicesForAll = (choice) =>
    Object.fromEntries(currentCandidates.map((candidate) => [candidate.protocol, choice]));

  const sendDecision = (choices) => {
    if (!currentRequestId || hasResponded) return;
    hasResponded = true;
    electronAPI.resolveExternalNodeCandidates?.({
      requestId: currentRequestId,
      choices,
    });
    closeModal();
  };

  const keepManagedForAll = () => {
    sendDecision(choicesForAll('managed'));
  };

  const renderCandidates = (candidates) => {
    list.textContent = '';
    for (const candidate of candidates) {
      const row = document.createElement('div');
      row.className = 'external-node-row';
      row.dataset.protocol = candidate.protocol;

      const details = document.createElement('div');
      details.className = 'external-node-details';

      const name = document.createElement('p');
      name.className = 'external-node-name';
      name.textContent = candidate.label || candidate.protocol;

      const endpoints = document.createElement('div');
      endpoints.className = 'external-node-endpoints';
      for (const endpoint of candidate.endpoints || []) {
        const code = document.createElement('code');
        code.textContent = endpoint;
        endpoints.append(code);
      }

      const choice = document.createElement('div');
      choice.className = 'external-node-choice';
      choice.setAttribute('role', 'radiogroup');
      choice.setAttribute('aria-label', `${name.textContent} node choice`);

      const radioName = `external-node-${candidate.protocol}`;
      for (const option of [
        { value: 'managed', label: 'Keep Managed' },
        { value: 'external', label: 'Use External' },
      ]) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = radioName;
        input.value = option.value;
        input.checked = option.value === 'managed';
        const text = document.createElement('span');
        text.textContent = option.label;
        label.append(input, text);
        choice.append(label);
      }

      details.append(name, endpoints);
      row.append(details, choice);
      list.append(row);
    }
  };

  const submitChoices = () => {
    const choices = {};
    for (const candidate of currentCandidates) {
      const checked = list.querySelector(
        `.external-node-row[data-protocol="${candidate.protocol}"] input:checked`
      );
      choices[candidate.protocol] = checked?.value === 'external' ? 'external' : 'managed';
    }
    sendDecision(choices);
  };

  const handleExternalNodeCandidates = (payload = {}) => {
    currentRequestId = payload.requestId || null;
    currentCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    hasResponded = false;
    if (!currentRequestId || !currentCandidates.length) {
      sendDecision({});
      return;
    }
    renderCandidates(currentCandidates);
    if (!modal.open && typeof modal.showModal === 'function') {
      modal.showModal();
    } else {
      modal.setAttribute('open', '');
    }
  };

  externalNodeCandidatesHandler = handleExternalNodeCandidates;
  while (queuedExternalNodeCandidatePayloads.length) {
    handleExternalNodeCandidates(queuedExternalNodeCandidatePayloads.shift());
  }

  submitBtn?.addEventListener('click', submitChoices);
  managedBtn?.addEventListener('click', keepManagedForAll);
  closeBtn?.addEventListener('click', keepManagedForAll);
  modal.addEventListener('cancel', (event) => {
    event.preventDefault();
    keepManagedForAll();
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) keepManagedForAll();
  });
}

async function initProfileIndicator() {
  const indicator = document.getElementById('profile-indicator');
  const nameEl = document.getElementById('profile-indicator-name');
  const menu = document.getElementById('profile-menu');
  const menuName = document.getElementById('profile-menu-name');
  const menuMeta = document.getElementById('profile-menu-meta');
  const profileList = document.getElementById('profile-menu-list');
  const createBtn = document.getElementById('profile-create-btn');
  const manageBtn = document.getElementById('profile-manage-btn');
  const menuStatus = document.getElementById('profile-menu-status');
  const createModal = document.getElementById('profile-create-modal');
  const createForm = document.getElementById('profile-create-form');
  const createNameInput = document.getElementById('profile-create-name');
  const createSubmitBtn = document.getElementById('profile-create-submit');
  const createCancelBtn = document.getElementById('profile-create-cancel');
  const createCloseBtn = document.getElementById('profile-create-close');
  const createStatus = document.getElementById('profile-create-status');
  if (!indicator || !nameEl) return;

  let activeProfile = null;
  let creatingProfile = false;

  const setMenuOpen = (open) => {
    if (!menu) return;
    menu.hidden = !open;
    indicator.setAttribute('aria-expanded', String(open));
  };

  const setMenuStatus = (message, kind = '') => {
    if (!menuStatus) return;
    menuStatus.textContent = message || '';
    menuStatus.className = 'profile-menu-status' + (kind ? ` ${kind}` : '');
    menuStatus.hidden = !message;
  };

  const openProfilesSettings = (subroute = '') => {
    setMenuOpen(false);
    loadTarget(subroute ? `freedom://settings/profiles/${subroute}` : 'freedom://settings/profiles');
  };

  const setCreateStatus = (message, kind = '') => {
    if (!createStatus) return;
    createStatus.textContent = message || '';
    createStatus.className = 'modal-status' + (kind ? ` ${kind}` : '');
    createStatus.hidden = !message;
  };

  const setCreateBusy = (busy) => {
    creatingProfile = busy;
    if (createSubmitBtn) createSubmitBtn.disabled = busy;
    if (createCancelBtn) createCancelBtn.disabled = busy;
    if (createCloseBtn) createCloseBtn.disabled = busy;
    if (createNameInput) createNameInput.disabled = busy;
  };

  const closeCreateModal = () => {
    if (creatingProfile || !createModal) return;
    if (createModal.open && typeof createModal.close === 'function') {
      createModal.close();
    } else {
      createModal.removeAttribute('open');
    }
  };

  const openCreateModal = () => {
    setMenuOpen(false);
    setCreateBusy(false);
    setCreateStatus('', '');
    if (createNameInput) createNameInput.value = '';
    if (createModal && !createModal.open && typeof createModal.showModal === 'function') {
      createModal.showModal();
    } else if (createModal) {
      createModal.setAttribute('open', '');
    }
    requestAnimationFrame(() => {
      createNameInput?.focus();
    });
  };

  const profileMetaText = (profile, isCurrent) => {
    if (isCurrent) return 'Current profile';
    if (profile?.isUnregistered) return 'Needs registration';
    return 'Open in new window';
  };

  const renderProfileList = (profiles = []) => {
    if (!profileList) return;
    profileList.textContent = '';

    const registeredProfiles = profiles.filter((profile) => profile?.isUnregistered !== true);
    const rows = registeredProfiles.length
      ? registeredProfiles
      : activeProfile
        ? [activeProfile]
        : [];

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'profile-menu-empty';
      empty.textContent = 'No profiles available';
      profileList.append(empty);
      return;
    }

    for (const profile of rows) {
      const isCurrent = profile?.isActive === true || profile?.id === activeProfile?.id;
      const displayName = profile?.displayName || profile?.id || 'Unnamed profile';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'profile-menu-item profile-menu-profile-item';
      button.setAttribute('role', 'menuitem');
      button.disabled = isCurrent;
      if (isCurrent) button.setAttribute('aria-current', 'true');

      const check = document.createElement('span');
      check.className = 'profile-menu-check';
      check.textContent = isCurrent ? '✓' : '';

      const text = document.createElement('span');
      text.className = 'profile-menu-item-text';

      const label = document.createElement('span');
      label.className = 'profile-menu-item-label';
      label.textContent = displayName;

      const meta = document.createElement('span');
      meta.className = 'profile-menu-item-meta';
      meta.textContent = profileMetaText(profile, isCurrent);

      text.append(label, meta);
      button.append(check, text);

      if (!isCurrent) {
        button.addEventListener('click', async () => {
          button.disabled = true;
          setMenuStatus(`Opening ${displayName}...`, 'success');
          try {
            const result = await electronAPI.openProfile?.(profile.id);
            if (!result?.success) {
              throw new Error(result?.error?.message || 'Profile could not be opened');
            }
            setMenuOpen(false);
          } catch (err) {
            button.disabled = false;
            setMenuStatus(err?.message || 'Profile could not be opened', 'error');
          }
        });
      }

      profileList.append(button);
    }
  };

  const refreshProfileList = async () => {
    if (!profileList) return;
    setMenuStatus('', '');
    try {
      const result = await electronAPI.listProfiles?.();
      if (!result?.success) {
        throw new Error(result?.error?.message || 'Profile list unavailable');
      }
      renderProfileList(result.profiles || []);
    } catch (err) {
      renderProfileList(activeProfile ? [activeProfile] : []);
      setMenuStatus(err?.message || 'Profile list unavailable', 'error');
    }
  };

  closeProfileMenu = () => setMenuOpen(false);

  indicator.addEventListener('click', (event) => {
    event.stopPropagation();
    const shouldOpen = menu?.hidden !== false;
    closeAllMenus();
    setMenuOpen(shouldOpen);
    if (shouldOpen) refreshProfileList();
  });

  createBtn?.addEventListener('click', openCreateModal);
  manageBtn?.addEventListener('click', () => openProfilesSettings());
  createCancelBtn?.addEventListener('click', closeCreateModal);
  createCloseBtn?.addEventListener('click', closeCreateModal);
  createModal?.addEventListener('cancel', (event) => {
    if (creatingProfile) event.preventDefault();
  });
  createModal?.addEventListener('click', (event) => {
    if (event.target === createModal) closeCreateModal();
  });
  createForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (creatingProfile) return;

    const displayName = createNameInput?.value.trim();
    if (!displayName) {
      setCreateStatus('Enter a profile name.', 'error');
      createNameInput?.focus();
      return;
    }

    setCreateBusy(true);
    setCreateStatus('Creating profile...', 'success');
    try {
      const createResult = await electronAPI.createProfile?.({ displayName });
      if (!createResult?.success) {
        throw new Error(createResult?.error?.message || 'Profile could not be created');
      }

      const profile = createResult.profile;
      const profileId = profile?.id;
      if (!profileId) {
        throw new Error('Profile was created but no profile id was returned');
      }

      setCreateStatus(`Opening ${profile.displayName || displayName}...`, 'success');
      const openResult = await electronAPI.openProfile?.(profileId);
      if (!openResult?.success) {
        throw new Error(openResult?.error?.message || 'Profile was created but could not be opened');
      }

      setCreateBusy(false);
      closeCreateModal();
      refreshProfileList();
    } catch (err) {
      setCreateStatus(err?.message || 'Profile could not be created', 'error');
      setCreateBusy(false);
      createNameInput?.focus();
    }
  });
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

  const renderProfile = (profile) => {
    activeProfile = profile;
    const label = profile?.displayName || profile?.id;
    if (!label) return;

    nameEl.textContent = label;
    indicator.title = profile?.isDev ? `${label} (dev)` : label;
    if (menuName) menuName.textContent = label;
    if (menuMeta) {
      const meta = [];
      if (profile?.isDev) meta.push('Development');
      menuMeta.textContent = meta.join(' · ');
      menuMeta.hidden = meta.length === 0;
    }
    indicator.hidden = false;
    if (menu?.hidden === false) refreshProfileList();
  };

  electronAPI.onProfileUpdated?.(renderProfile);

  try {
    const profile = await electronAPI.getActiveProfile?.();
    renderProfile(profile);
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

  const showToast = (text, showAction = false, actionLabel = 'Install now') => {
    message.textContent = text;
    actionBtn.hidden = !showAction;
    actionBtn.textContent = actionLabel;
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
      showToast(data.message, true, data.actionLabel || 'Install now');
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
  initExternalNodeCandidatesModal();
  initPlatformUI();
  initProfileIndicator();
  initUpdateNotifications();
});
