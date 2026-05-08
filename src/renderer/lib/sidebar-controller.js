/**
 * Sidebar Controller Factory
 *
 * Builds a fixed-width right-side panel controller that listens to a settings
 * feature flag, toggles via a toolbar button + Cmd/Ctrl+Shift+<key>, and
 * coordinates with sibling sidebars: opening one closes any other.
 *
 * Sibling coordination uses `sidebar-opened` / `sidebar-closed` events on
 * `document`, with `detail.id` identifying the source instance.
 */

import { pushDebug } from './debug.js';

export function createSidebarController({
  id,
  toggleBtnId,
  closeBtnId,
  featureFlagKey,
  keybindingKey,
  name,
}) {
  let isOpen = false;
  let featureEnabled = false;

  let sidebar;
  let toggleBtn;
  let closeBtn;

  function init() {
    sidebar = document.getElementById(id);
    toggleBtn = document.getElementById(toggleBtnId);
    closeBtn = closeBtnId ? document.getElementById(closeBtnId) : null;

    if (!sidebar || !toggleBtn) {
      console.error(`[Sidebar:${name}] Required elements not found`);
      return;
    }

    window.electronAPI
      .getSettings()
      .then((settings) => {
        featureEnabled = settings?.[featureFlagKey] === true;
        applyFeatureVisibility();
      })
      .catch(() => {
        featureEnabled = false;
        applyFeatureVisibility();
      });

    window.addEventListener('settings:updated', (event) => {
      const wasEnabled = featureEnabled;
      featureEnabled = event.detail?.[featureFlagKey] === true;
      applyFeatureVisibility();
      if (wasEnabled && !featureEnabled && isOpen) {
        close();
      }
    });

    applyState();

    toggleBtn.addEventListener('click', toggle);
    if (closeBtn) {
      closeBtn.addEventListener('click', close);
    }

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === keybindingKey) {
        if (!featureEnabled) return;
        e.preventDefault();
        toggle();
      }
    });

    // Mutual exclusion: when a sibling sidebar opens, close this one.
    document.addEventListener('sidebar-opened', (event) => {
      if (event.detail?.id !== id && isOpen) {
        close();
      }
    });

    pushDebug(`[Sidebar:${name}] Initialized`);
  }

  function applyFeatureVisibility() {
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('hidden', !featureEnabled);
  }

  function toggle() {
    if (!featureEnabled) return;
    if (isOpen) {
      close();
    } else {
      open();
    }
  }

  function open() {
    if (!featureEnabled) return;
    if (isOpen) return;
    isOpen = true;
    applyState();
    document.dispatchEvent(new CustomEvent('sidebar-opened', { detail: { id } }));
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    applyState();
    document.dispatchEvent(new CustomEvent('sidebar-closed', { detail: { id } }));
  }

  function isVisible() {
    return isOpen;
  }

  function isFeatureEnabled() {
    return featureEnabled;
  }

  function applyState() {
    if (!sidebar || !toggleBtn) return;
    if (isOpen) {
      sidebar.classList.remove('collapsed');
      toggleBtn.classList.add('active');
      toggleBtn.setAttribute('aria-expanded', 'true');
    } else {
      sidebar.classList.add('collapsed');
      toggleBtn.classList.remove('active');
      toggleBtn.setAttribute('aria-expanded', 'false');
    }
  }

  return { init, toggle, open, close, isVisible, isFeatureEnabled };
}
