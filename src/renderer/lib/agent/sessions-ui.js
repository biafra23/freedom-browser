/**
 * Sessions UI
 *
 * Master-detail swap inside the AI sidebar. The toolbar's sessions
 * toggle button switches between the chat view and a list of
 * persisted sessions. Selecting a row loads that session back into
 * the chat view; the existing "+ New" button starts a fresh session.
 *
 * Inline rename + delete-with-confirm. Refresh on view-show, plus
 * after any rename/delete to keep the list in sync.
 */

import { pushDebug } from '../debug.js';
import { loadSessionById, getCurrentSessionId } from './chat-ui.js';

let toggleBtn;
let chatView;
let sessionsView;
let listEl;
let emptyEl;

let isOpen = false;

export function initSessionsUi() {
  toggleBtn = document.getElementById('agent-sessions-toggle-btn');
  chatView = document.getElementById('agent-chat-view');
  sessionsView = document.getElementById('agent-sessions-view');
  listEl = document.getElementById('agent-sessions-list');
  emptyEl = document.getElementById('agent-sessions-empty');

  if (!toggleBtn || !chatView || !sessionsView || !listEl) {
    pushDebug('[SessionsUi] Required elements not found');
    return;
  }

  toggleBtn.addEventListener('click', () => {
    if (isOpen) showChatView();
    else showSessionsView();
  });

  // Re-fetch the list whenever the AI sidebar opens — sessions may have
  // changed via persistence in the chat view since the last list-show.
  document.addEventListener('sidebar-opened', (event) => {
    if (event.detail?.id !== 'ai-sidebar') return;
    if (isOpen) refreshList();
  });

  pushDebug('[SessionsUi] Initialized');
}

async function showSessionsView() {
  isOpen = true;
  toggleBtn.setAttribute('aria-pressed', 'true');
  chatView.classList.add('hidden');
  sessionsView.classList.remove('hidden');
  await refreshList();
}

function showChatView() {
  isOpen = false;
  toggleBtn.setAttribute('aria-pressed', 'false');
  sessionsView.classList.add('hidden');
  chatView.classList.remove('hidden');
}

async function refreshList() {
  let sessions = [];
  try {
    sessions = (await window.agent.listSessions(50)) || [];
  } catch (err) {
    pushDebug(`[SessionsUi] listSessions failed: ${err?.message || err}`);
  }

  listEl.innerHTML = '';
  if (sessions.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  const current = getCurrentSessionId();
  for (const session of sessions) {
    listEl.appendChild(renderRow(session, session.id === current));
  }
}

function renderRow(session, isActive) {
  const li = document.createElement('li');
  li.className = 'agent-session-row';
  if (isActive) li.classList.add('active');
  li.dataset.sessionId = session.id;

  const body = document.createElement('div');
  body.className = 'agent-session-row-body';

  const title = document.createElement('div');
  title.className = 'agent-session-row-title';
  if (session.title) {
    title.textContent = session.title;
  } else {
    title.textContent = '(Untitled)';
    title.classList.add('untitled');
  }

  const meta = document.createElement('div');
  meta.className = 'agent-session-row-meta';
  meta.textContent = formatRelativeTime(session.updated_at);

  body.appendChild(title);
  body.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'agent-session-row-actions';
  actions.appendChild(makeActionButton('Rename', renameIconSvg(), (e) => {
    e.stopPropagation();
    startInlineRename(li, session, title);
  }));
  actions.appendChild(makeActionButton('Delete', trashIconSvg(), (e) => {
    e.stopPropagation();
    startInlineDelete(li, session, actions);
  }));

  li.appendChild(body);
  li.appendChild(actions);

  li.addEventListener('click', async () => {
    const ok = await loadSessionById(session.id);
    if (ok) showChatView();
  });

  return li;
}

function makeActionButton(label, svg, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'agent-session-action-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = svg;
  btn.addEventListener('click', onClick);
  return btn;
}

function startInlineRename(rowEl, session, titleEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'agent-session-rename-input';
  input.value = session.title || '';
  input.maxLength = 80;

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== session.title) {
      try {
        await window.agent.renameSession(session.id, newTitle);
      } catch (err) {
        pushDebug(`[SessionsUi] rename failed: ${err?.message || err}`);
      }
    }
    refreshList();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      refreshList();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());

  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function startInlineDelete(rowEl, session, actionsEl) {
  // Replace the action buttons with a confirm/cancel pair. Click outside
  // the row or click cancel to abort.
  const confirmBox = document.createElement('div');
  confirmBox.className = 'agent-session-confirm-delete';

  const yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'agent-session-confirm-btn';
  yesBtn.textContent = 'Delete';
  yesBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await window.agent.deleteSession(session.id);
    } catch (err) {
      pushDebug(`[SessionsUi] delete failed: ${err?.message || err}`);
    }
    refreshList();
  });

  const noBtn = document.createElement('button');
  noBtn.type = 'button';
  noBtn.className = 'agent-session-confirm-btn cancel';
  noBtn.textContent = 'Cancel';
  noBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshList();
  });

  confirmBox.appendChild(yesBtn);
  confirmBox.appendChild(noBtn);
  actionsEl.replaceWith(confirmBox);
}

function formatRelativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week}w ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

function renameIconSvg() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>
    </svg>
  `;
}

function trashIconSvg() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
  `;
}

// Exported for tests.
export const _internals = { formatRelativeTime, refreshList, showSessionsView, showChatView };
