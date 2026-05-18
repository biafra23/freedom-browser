// Chrome-style link hover URL preview at the bottom of the page area.

let linkStatusEl = null;
let linkStatusUrlEl = null;
let hideTimer = null;
let showTimer = null;

const SHOW_DELAY_MS = 150;
const HIDE_DELAY_MS = 250;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

const scheduleFrame = (callback) => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(callback);
  } else {
    callback();
  }
};

export const initLinkStatus = () => {
  linkStatusEl = document.getElementById('link-status');
  linkStatusUrlEl = document.getElementById('link-status-url');
};

export const clearLinkStatus = () => {
  if (!linkStatusEl || !linkStatusUrlEl) return;

  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  const finishHide = () => {
    if (!linkStatusEl || !linkStatusUrlEl) return;
    linkStatusUrlEl.textContent = '';
    linkStatusEl.hidden = true;
  };

  if (!linkStatusEl.classList.contains('visible')) {
    finishHide();
    return;
  }

  linkStatusEl.classList.remove('visible');

  if (prefersReducedMotion()) {
    finishHide();
    return;
  }

  hideTimer = setTimeout(() => {
    hideTimer = null;
    finishHide();
  }, HIDE_DELAY_MS);
};

const revealLinkStatus = (url) => {
  if (!linkStatusEl || !linkStatusUrlEl) return;

  linkStatusUrlEl.textContent = url;
  linkStatusEl.hidden = false;

  if (prefersReducedMotion()) {
    linkStatusEl.classList.add('visible');
    return;
  }

  linkStatusEl.classList.remove('visible');
  scheduleFrame(() => {
    linkStatusEl?.classList.add('visible');
  });
};

export const showLinkStatus = (url) => {
  if (!linkStatusEl || !linkStatusUrlEl) return;

  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) {
    clearLinkStatus();
    return;
  }

  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  // Already visible: swap text in place, no fade.
  if (linkStatusEl.classList.contains('visible')) {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    linkStatusUrlEl.textContent = trimmed;
    return;
  }

  // Not yet visible: defer reveal so brief mouse passes don't flicker the bar.
  if (showTimer) {
    clearTimeout(showTimer);
  }
  showTimer = setTimeout(() => {
    showTimer = null;
    revealLinkStatus(trimmed);
  }, SHOW_DELAY_MS);
};

/**
 * Handle webview `update-target-url` for the active tab.
 * @param {number} tabId
 * @param {string} url
 * @param {number|null} activeTabId
 */
export const handleUpdateTargetUrl = (tabId, url, activeTabId) => {
  if (tabId !== activeTabId) return;

  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) {
    clearLinkStatus();
    return;
  }
  showLinkStatus(trimmed);
};
