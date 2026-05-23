/**
 * Publisher Identities Module
 *
 * Sidebar sub-screen listing all origins that have Swarm feed publisher
 * identities. Shows grant status and lets users manage the active identity.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { escapeHtml } from './wallet-utils.js';

let screen;
let backBtn;
let filterInput;
let listContainer;
let emptyMessage;
let listView;
let detailView;
let detailOrigin;
let detailCurrent;
let detailList;
let detailNote;
let createAppBtn;
let useBeeBtn;

let cachedEntries = [];
let activeDetailOrigin = null;

export function initPublisherIdentities() {
  screen = document.getElementById('sidebar-publisher-identities');
  backBtn = document.getElementById('publisher-identities-back');
  filterInput = document.getElementById('publisher-identity-filter');
  listContainer = document.getElementById('publisher-identity-list');
  emptyMessage = document.getElementById('publisher-identity-empty');
  listView = document.getElementById('publisher-identity-list-view');
  detailView = document.getElementById('publisher-identity-detail');
  detailOrigin = document.getElementById('publisher-identity-detail-origin');
  detailCurrent = document.getElementById('publisher-identity-detail-current');
  detailList = document.getElementById('publisher-identity-detail-list');
  detailNote = document.getElementById('publisher-identity-detail-note');
  createAppBtn = document.getElementById('publisher-identity-create-app');
  useBeeBtn = document.getElementById('publisher-identity-use-bee');

  registerScreenHider(() => closePublisherIdentities());

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (activeDetailOrigin) {
        showPublisherIdentityList();
      } else {
        closePublisherIdentities();
      }
    });
  }

  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const query = filterInput.value.toLowerCase().trim();
      renderList(cachedEntries, query);
    });
  }

  createAppBtn?.addEventListener('click', () => createAppScopedIdentityForDetail());
  useBeeBtn?.addEventListener('click', () => activateBeeIdentityForDetail());
}

export async function openPublisherIdentities() {
  try {
    cachedEntries = await window.swarmFeedStore?.getAllOrigins?.() || [];
  } catch {
    cachedEntries = [];
  }

  if (filterInput) filterInput.value = '';
  showPublisherIdentityList();

  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
}

export function closePublisherIdentities() {
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  activeDetailOrigin = null;
}

function renderList(entries, query) {
  if (!listContainer) return;

  const filtered = query
    ? entries.filter((e) => e.origin.toLowerCase().includes(query))
    : entries;

  listContainer.innerHTML = '';

  if (filtered.length === 0) {
    emptyMessage?.classList.remove('hidden');
    if (emptyMessage) {
      emptyMessage.textContent = query ? 'No matching identities.' : 'No publisher identities yet.';
    }
    return;
  }

  emptyMessage?.classList.add('hidden');

  for (const entry of filtered) {
    const modeBadge = entry.identityMode === 'app-scoped'
      ? '<span class="publisher-identity-badge badge-app-scoped">App-scoped</span>'
      : '<span class="publisher-identity-badge badge-bee-wallet">Bee wallet</span>';

    const grantDot = entry.feedGranted
      ? '<span class="publisher-identity-grant-dot" title="Feed access active"></span>'
      : '';

    const feedLabel = entry.feedCount === 1 ? '1 feed' : `${entry.feedCount} feeds`;
    const identityLabel = entry.identityCount === 1 ? '1 identity' : `${entry.identityCount || 1} identities`;

    const item = document.createElement('div');
    item.className = 'publisher-identity-item';
    item.title = entry.origin;
    item.innerHTML = `<div class="publisher-identity-header">
      <span class="publisher-identity-origin">${escapeHtml(truncateOrigin(entry.origin))}</span>
      ${grantDot}
    </div>
    <div class="publisher-identity-meta">
      ${modeBadge}
      <span class="publisher-identity-feeds">${feedLabel}</span>
      <span class="publisher-identity-feeds">${identityLabel}</span>
    </div>`;

    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'publisher-identity-manage-btn';
    manageBtn.textContent = 'Manage';
    manageBtn.addEventListener('click', () => openOriginIdentityDetail(entry.origin));
    item.appendChild(manageBtn);
    listContainer.appendChild(item);
  }
}

function showPublisherIdentityList() {
  activeDetailOrigin = null;
  detailView?.classList.add('hidden');
  listView?.classList.remove('hidden');
  const query = filterInput?.value.toLowerCase().trim() || '';
  renderList(cachedEntries, query);
}

async function openOriginIdentityDetail(origin, note = '') {
  activeDetailOrigin = origin;
  listView?.classList.add('hidden');
  detailView?.classList.remove('hidden');
  if (detailOrigin) detailOrigin.textContent = origin;

  const state = await window.swarmFeedStore?.getOriginIdentities?.(origin);
  renderIdentityDetail(state, note);
}

function renderIdentityDetail(state, note) {
  const active = state?.identities?.find((identity) => identity.id === state.activeIdentityId);

  if (detailCurrent) {
    detailCurrent.innerHTML = active
      ? `<div class="publisher-identity-current-title">${escapeHtml(identityLabel(active))}</div>
        <div class="publisher-identity-current-desc">Feed and SOC writes use this signing owner by default.</div>`
      : '<div class="publisher-identity-current-desc">No publisher identity found.</div>';
  }

  if (detailList) {
    detailList.innerHTML = '';
    for (const identity of state?.identities || []) {
      detailList.appendChild(buildIdentityRow(identity, identity.id === state.activeIdentityId));
    }
  }

  if (detailNote) {
    detailNote.textContent = note;
    detailNote.classList.toggle('hidden', !note);
  }
}

function buildIdentityRow(identity, isActive) {
  const modeBadge = identity.mode === 'app-scoped'
    ? '<span class="publisher-identity-badge badge-app-scoped">App-scoped</span>'
    : '<span class="publisher-identity-badge badge-bee-wallet">Bee wallet</span>';

  const item = document.createElement('div');
  item.className = `publisher-identity-item${isActive ? ' is-active' : ''}`;
  item.innerHTML = `<div class="publisher-identity-header">
    <span class="publisher-identity-origin">${escapeHtml(identityLabel(identity))}</span>
  </div>
  <div class="publisher-identity-meta">
    ${modeBadge}
    <span class="publisher-identity-feeds">${isActive ? 'Active' : 'Inactive'}</span>
  </div>`;

  const useBtn = document.createElement('button');
  useBtn.type = 'button';
  useBtn.className = 'publisher-identity-use-btn';
  useBtn.textContent = isActive ? 'Active' : 'Use this identity';
  useBtn.disabled = isActive;
  useBtn.addEventListener('click', () => activateIdentityForDetail(identity.id));
  item.appendChild(useBtn);
  return item;
}

function identityLabel(identity) {
  if (!identity) return 'Publisher identity';
  return identity.label || (identity.mode === 'bee-wallet' ? 'Bee wallet identity' : 'App-scoped identity');
}

function confirmIdentitySwitch() {
  return confirm('Changing publisher identity changes the signing owner for future SOC writes. Existing high-level feeds keep using the identity that created them. Feed auto-approve will be turned off.');
}

async function disableFeedAutoApprove(origin) {
  await window.swarmPermissions?.setAutoApprove?.(origin, 'feeds', false);
}

async function activateIdentityForDetail(identityId) {
  if (!activeDetailOrigin || !identityId || !confirmIdentitySwitch()) return;
  await window.swarmFeedStore.activateFeedIdentity(activeDetailOrigin, identityId);
  await disableFeedAutoApprove(activeDetailOrigin);
  await openOriginIdentityDetail(activeDetailOrigin, 'Feed auto-approve was turned off after changing identity.');
  cachedEntries = await window.swarmFeedStore?.getAllOrigins?.() || [];
}

async function createAppScopedIdentityForDetail() {
  if (!activeDetailOrigin || !confirmIdentitySwitch()) return;
  await window.swarmFeedStore.createAppScopedIdentity(activeDetailOrigin);
  await disableFeedAutoApprove(activeDetailOrigin);
  await openOriginIdentityDetail(activeDetailOrigin, 'Created and activated a new app-scoped identity. Feed auto-approve was turned off.');
  cachedEntries = await window.swarmFeedStore?.getAllOrigins?.() || [];
}

async function activateBeeIdentityForDetail() {
  if (!activeDetailOrigin || !confirmIdentitySwitch()) return;
  await window.swarmFeedStore.ensureBeeWalletIdentity(activeDetailOrigin, { activate: true });
  await disableFeedAutoApprove(activeDetailOrigin);
  await openOriginIdentityDetail(activeDetailOrigin, 'Bee wallet identity is now active. Feed auto-approve was turned off.');
  cachedEntries = await window.swarmFeedStore?.getAllOrigins?.() || [];
}

function truncateOrigin(origin) {
  if (origin.length <= 40) return origin;
  return origin.slice(0, 20) + '\u2026' + origin.slice(-17);
}
