/**
 * Channels UI
 *
 * Master-detail swap inside the AI sidebar, sibling to sessions-ui. The
 * toolbar's channels toggle button switches the chat panel between three
 * views: chat, sessions, and channels.
 *
 * A "channel" is an XMTP MLS group (see src/main/messaging/channel.js) the
 * local installation is a member of. Selecting a row hands the channel off
 * to chat-ui.loadChannel which puts the chat view into channel mode —
 * composer publishes via window.messaging instead of starting an Ollama turn.
 *
 * The new-channel form takes a peer 0x address; XMTP creates the group with
 * that peer and our own installation as members. Failures (peer not on
 * XMTP, network error) bubble up as inline error text.
 */

import { pushDebug } from '../debug.js';
import { loadChannel, getActiveChannelId } from './chat-ui.js';
import { showVaultUnlock } from '../wallet/vault-unlock.js';

let toggleBtn;
let sessionsToggleBtn;
let chatView;
let sessionsView;
let channelsView;
let listEl;
let emptyEl;
let statusEl;
let formEl;
let peerInput;
let nameInput;
let createBtn;

let isOpen = false;
let unsubscribeStatus;
let unsubscribeMessages;

export function initChannelsUi() {
  toggleBtn = document.getElementById('agent-channels-toggle-btn');
  sessionsToggleBtn = document.getElementById('agent-sessions-toggle-btn');
  chatView = document.getElementById('agent-chat-view');
  sessionsView = document.getElementById('agent-sessions-view');
  channelsView = document.getElementById('agent-channels-view');
  listEl = document.getElementById('agent-channels-list');
  emptyEl = document.getElementById('agent-channels-empty');
  statusEl = document.getElementById('agent-channels-status');
  formEl = document.getElementById('agent-channel-new-form');
  peerInput = document.getElementById('agent-channel-peer-input');
  nameInput = document.getElementById('agent-channel-name-input');
  createBtn = document.getElementById('agent-channel-create-btn');

  if (!toggleBtn || !chatView || !channelsView || !listEl || !formEl) {
    pushDebug('[ChannelsUi] Required elements not found');
    return;
  }

  if (!window.messaging) {
    pushDebug('[ChannelsUi] window.messaging bridge not available');
    return;
  }

  toggleBtn.addEventListener('click', () => {
    if (isOpen) showChatView();
    else showChannelsView();
  });

  formEl.addEventListener('submit', handleCreateChannel);

  // Re-fetch the list whenever the AI sidebar opens — channels may have
  // been created via main-process flows since the last view-show.
  document.addEventListener('sidebar-opened', (event) => {
    if (event.detail?.id !== 'ai-sidebar') return;
    if (isOpen) refreshList();
  });

  // Status updates from the messaging runtime (start/stop) re-render the
  // status banner so the user sees "ready" vs "locked".
  unsubscribeStatus = window.messaging.onStatusUpdate?.(() => {
    if (isOpen) {
      renderStatus().catch((err) => pushDebug(`[ChannelsUi] status refresh: ${err?.message || err}`));
      refreshList().catch((err) => pushDebug(`[ChannelsUi] list refresh: ${err?.message || err}`));
    }
  });

  // Live message handler updates the badge / row meta so users see "new"
  // markers on inactive channels even when the chat view is showing
  // a different channel. Currently a no-op stub; the chat-ui takes care
  // of the active-channel render.
  unsubscribeMessages = window.messaging.onMessage?.(({ channelId }) => {
    if (!isOpen) return;
    markChannelActivity(channelId);
  });

  pushDebug('[ChannelsUi] Initialized');
}

async function showChannelsView() {
  isOpen = true;
  toggleBtn.setAttribute('aria-pressed', 'true');
  sessionsToggleBtn?.setAttribute('aria-pressed', 'false');
  chatView.classList.add('hidden');
  sessionsView?.classList.add('hidden');
  channelsView.classList.remove('hidden');
  await renderStatus();
  await refreshList();
}

function showChatView() {
  isOpen = false;
  toggleBtn.setAttribute('aria-pressed', 'false');
  channelsView.classList.add('hidden');
  chatView.classList.remove('hidden');
}

async function renderStatus() {
  if (!statusEl) return;

  // Four shapes to distinguish so the user knows what to do:
  //   1. IPC handler not registered → main process is stale (relaunch needed)
  //   2. Handler ok, started:false + no error, vault LOCKED → "Unlock vault" button
  //   3. Handler ok, started:false (with or without error), vault UNLOCKED
  //      → "Start messaging" retry button (with optional error text)
  //   4. Handler ok, started:true → "Ready · 0x…"
  let status = null;
  let bridgeError = null;
  try {
    const res = await window.messaging.getStatus();
    if (res?.ok) {
      status = res.data;
    } else if (res && !res.ok) {
      bridgeError = res.error || 'unknown error';
    }
  } catch (err) {
    bridgeError = err?.message || String(err);
    pushDebug(`[ChannelsUi] getStatus failed: ${bridgeError}`);
  }

  statusEl.innerHTML = '';

  if (bridgeError) {
    const note = document.createElement('div');
    note.className = 'agent-channels-status-note agent-channels-error';
    // "No handler registered for ..." is electron's wording for an IPC
    // channel without a handler — almost always means the main process
    // is older than the renderer.
    if (/no handler registered/i.test(bridgeError)) {
      note.textContent =
        'Messaging IPC not available — fully quit and relaunch Freedom (a renderer reload is not enough after main-process changes).';
    } else {
      note.textContent = `Messaging error: ${bridgeError}`;
    }
    statusEl.appendChild(note);
    formEl.classList.add('hidden');
    return;
  }

  if (!status || !status.started) {
    formEl.classList.add('hidden');
    let unlocked = false;
    try {
      // identity.isUnlocked returns { isUnlocked: boolean }; coercing the
      // wrapper object directly always reads as truthy.
      const res = await window.identity?.isUnlocked?.();
      unlocked = !!res?.isUnlocked;
    } catch (err) {
      pushDebug(`[ChannelsUi] identity.isUnlocked failed: ${err?.message || err}`);
    }

    const note = document.createElement('div');
    note.className = 'agent-channels-status-note';
    if (unlocked) {
      note.textContent = status?.error
        ? `Messaging offline: ${status.error}`
        : 'Messaging is offline. Click Start to connect to the XMTP network.';
    } else {
      note.textContent = 'Messaging offline. Unlock your vault to enable.';
    }
    statusEl.appendChild(note);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-channels-action-btn';
    btn.textContent = unlocked ? 'Start messaging' : 'Unlock vault';
    btn.addEventListener('click', () =>
      handleUnlockOrStart({ alreadyUnlocked: unlocked, btn })
    );
    statusEl.appendChild(btn);
    return;
  }

  formEl.classList.remove('hidden');
  const note = document.createElement('div');
  note.className = 'agent-channels-status-note ready';
  note.textContent = `Ready · ${shortenInboxOrAddress(status.address)}`;
  statusEl.appendChild(note);
}

async function handleUnlockOrStart({ alreadyUnlocked, btn }) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('busy');
  }
  try {
    if (!alreadyUnlocked) {
      // showVaultUnlock returns a promise that resolves on successful
      // unlock and rejects on cancel. The unlock IPC fires the messaging
      // auto-start path inside identity-manager; we still call start()
      // afterwards as a belt-and-braces in case the auto-start failed.
      try {
        await showVaultUnlock('Messaging');
      } catch (err) {
        pushDebug(`[ChannelsUi] vault unlock dismissed: ${err?.message || err}`);
        return;
      }
    }

    const res = await window.messaging.start();
    if (res && !res.ok) {
      flashError(res.error || 'Start failed');
      return;
    }
    if (res?.ok && res.data && res.data.started === false && res.data.error) {
      flashError(`Start failed: ${res.data.error}`);
      return;
    }
    await renderStatus();
    await refreshList();
  } catch (err) {
    flashError(err?.message || String(err));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }
}

async function handleCreateChannel(event) {
  event.preventDefault();
  const peer = peerInput.value.trim();
  const name = nameInput.value.trim();
  if (!peer) return;
  if (!/^0x[0-9a-fA-F]{40}$/.test(peer)) {
    flashError('Peer must be a 0x-prefixed Ethereum address (40 hex chars).');
    return;
  }
  setBusy(true);
  try {
    const res = await window.messaging.createChannel({
      peerAddresses: [peer],
      name: name || null,
    });
    if (!res?.ok) {
      flashError(res?.error || 'Create failed');
      return;
    }
    peerInput.value = '';
    nameInput.value = '';
    await refreshList();
    // Open the freshly-created channel.
    if (res.data) {
      await loadChannel(res.data);
      showChatView();
    }
  } catch (err) {
    flashError(err?.message || String(err));
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  if (!createBtn) return;
  createBtn.disabled = busy;
  if (busy) createBtn.classList.add('busy');
  else createBtn.classList.remove('busy');
}

function flashError(text) {
  if (!statusEl) return;
  const existing = statusEl.querySelector('.agent-channels-error');
  if (existing) existing.remove();
  const note = document.createElement('div');
  note.className = 'agent-channels-status-note agent-channels-error';
  note.textContent = text;
  statusEl.appendChild(note);
}

async function refreshList() {
  let channels = [];
  try {
    const res = await window.messaging.listChannels();
    if (res?.ok && Array.isArray(res.data)) channels = res.data;
    else if (res && !res.ok) pushDebug(`[ChannelsUi] listChannels: ${res.error}`);
  } catch (err) {
    pushDebug(`[ChannelsUi] listChannels threw: ${err?.message || err}`);
  }

  listEl.innerHTML = '';
  if (channels.length === 0) {
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');
  const activeId = getActiveChannelId();
  for (const ch of channels) {
    listEl.appendChild(renderRow(ch, ch.id === activeId));
  }
}

function renderRow(channel, isActive) {
  const li = document.createElement('li');
  li.className = 'agent-session-row agent-channel-row';
  if (isActive) li.classList.add('active');
  li.dataset.channelId = channel.id;

  const body = document.createElement('div');
  body.className = 'agent-session-row-body';

  const title = document.createElement('div');
  title.className = 'agent-session-row-title';
  if (channel.name) {
    title.textContent = channel.name;
  } else {
    title.textContent = shortChannelId(channel.id);
    title.classList.add('untitled');
  }

  const meta = document.createElement('div');
  meta.className = 'agent-session-row-meta';
  meta.textContent = `${channel.memberCount ?? channel.memberInboxIds?.length ?? 0} member(s)`;

  body.appendChild(title);
  body.appendChild(meta);
  li.appendChild(body);

  li.addEventListener('click', async () => {
    const ok = await loadChannel(channel);
    if (ok) {
      showChatView();
    }
  });

  return li;
}

function markChannelActivity(channelId) {
  // Stub: future enhancement could add an unread badge here. For now the
  // active row in renderRow is enough.
  void channelId;
}

function shortChannelId(id) {
  if (!id || typeof id !== 'string') return '(channel)';
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function shortenInboxOrAddress(s) {
  if (!s || typeof s !== 'string') return 'unknown';
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

// Exposed for tests and for graceful teardown in test harnesses.
export const _internals = {
  shortChannelId,
  shortenInboxOrAddress,
  teardown() {
    unsubscribeStatus?.();
    unsubscribeStatus = null;
    unsubscribeMessages?.();
    unsubscribeMessages = null;
  },
};
