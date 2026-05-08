/**
 * Agent Sidebar
 *
 * Left-side panel housing the chat UI. Manages open/closed state,
 * keyboard shortcut, and toggle button. Mirrors the right wallet
 * sidebar's collapsed-width pattern.
 *
 * Visibility is currently always-on (no feature flag yet) — formal
 * Phase 0 of the plan adds an `enableLocalAgent` setting to gate this
 * behind Experimental.
 */

let isOpen = false;
let sidebar;
let toggleBtn;
let closeBtn;

export function initAgentSidebar() {
  sidebar = document.getElementById('agent-sidebar');
  toggleBtn = document.getElementById('agent-toggle-btn');
  closeBtn = document.getElementById('agent-sidebar-close');

  if (!sidebar || !toggleBtn) {
    console.warn('[AgentSidebar] Required elements not found');
    return;
  }

  applyState();

  toggleBtn.addEventListener('click', toggle);
  closeBtn?.addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
      e.preventDefault();
      toggle();
    }
  });

  console.log('[AgentSidebar] Initialized');
}

export function toggle() {
  isOpen = !isOpen;
  applyState();
  if (isOpen) {
    document.dispatchEvent(new CustomEvent('agent-sidebar-opened'));
  } else {
    document.dispatchEvent(new CustomEvent('agent-sidebar-closed'));
  }
}

export function open() {
  if (isOpen) return;
  isOpen = true;
  applyState();
  document.dispatchEvent(new CustomEvent('agent-sidebar-opened'));
}

export function close() {
  if (!isOpen) return;
  isOpen = false;
  applyState();
  document.dispatchEvent(new CustomEvent('agent-sidebar-closed'));
}

export function isVisible() {
  return isOpen;
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
