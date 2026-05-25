/**
 * Permission Management Subscreens
 *
 * Per-site permission management for wallet and Swarm connections.
 * Accessible by clicking the connection banner info area.
 */

import { walletState, hideAllSubscreens, registerScreenHider } from './wallet-state.js';
import { open as openSidebarPanel } from '../sidebar.js';
import { updateConnectionBanner, disconnectDapp } from './dapp-connect.js';
import { updateSwarmConnectionBanner, disconnectSwarmApp } from './swarm-connect.js';
import { showVaultUnlock } from './vault-unlock.js';
import { showPublisherIdentityCreate } from './publisher-identity-create.js';
import {
  BEE_WALLET_IDENTITY_ID,
  getActivePublisherIdentity,
  identityLabel,
  renderPublisherIdentitySelector,
} from './publisher-identity-selector.js';

// Wallet permission management
let dappPermsScreen;
let dappPermsBack;
let dappPermsSite;
let dappPermsSigningToggle;
let dappPermsTxList;
let dappPermsDisconnect;
let dappPermsKey = null;

// Swarm permission management
let swarmPermsScreen;
let swarmPermsBack;
let swarmPermsSite;
let swarmPermsPublishToggle;
let swarmPermsFeedsToggle;
let swarmPermsIdentitySelector;
let swarmPermsIdentityNote;
let swarmPermsDisconnect;
let swarmPermsKey = null;
let swarmPermsIdentityState = null;

export function initPermissionManage() {
  // Wallet permission screen
  dappPermsScreen = document.getElementById('sidebar-dapp-permissions');
  dappPermsBack = document.getElementById('dapp-perms-back');
  dappPermsSite = document.getElementById('dapp-perms-site');
  dappPermsSigningToggle = document.getElementById('dapp-perms-signing-toggle');
  dappPermsTxList = document.getElementById('dapp-perms-tx-list');
  dappPermsDisconnect = document.getElementById('dapp-perms-disconnect');

  dappPermsBack?.addEventListener('click', closeDappPerms);
  dappPermsDisconnect?.addEventListener('click', handleDappDisconnect);
  registerScreenHider(() => closeDappPerms());
  dappPermsSigningToggle?.addEventListener('change', async () => {
    if (dappPermsKey) {
      await window.dappPermissions.setSigningAutoApprove(dappPermsKey, dappPermsSigningToggle.checked);
      updateConnectionBanner(dappPermsKey);
    }
  });

  // Swarm permission screen
  swarmPermsScreen = document.getElementById('sidebar-swarm-permissions');
  swarmPermsBack = document.getElementById('swarm-perms-back');
  swarmPermsSite = document.getElementById('swarm-perms-site');
  swarmPermsPublishToggle = document.getElementById('swarm-perms-publish-toggle');
  swarmPermsFeedsToggle = document.getElementById('swarm-perms-feeds-toggle');
  swarmPermsIdentitySelector = document.getElementById('swarm-perms-identity-selector');
  swarmPermsIdentityNote = document.getElementById('swarm-perms-identity-note');
  swarmPermsDisconnect = document.getElementById('swarm-perms-disconnect');

  swarmPermsBack?.addEventListener('click', closeSwarmPerms);
  swarmPermsDisconnect?.addEventListener('click', handleSwarmDisconnect);
  registerScreenHider(() => closeSwarmPerms());
  swarmPermsPublishToggle?.addEventListener('change', async () => {
    if (swarmPermsKey) {
      await window.swarmPermissions.setAutoApprove(swarmPermsKey, 'publish', swarmPermsPublishToggle.checked);
      updateSwarmConnectionBanner(swarmPermsKey);
    }
  });
  swarmPermsFeedsToggle?.addEventListener('change', async () => {
    if (swarmPermsKey) {
      await window.swarmPermissions.setAutoApprove(swarmPermsKey, 'feeds', swarmPermsFeedsToggle.checked);
      updateSwarmConnectionBanner(swarmPermsKey);
    }
  });
}

export async function showDappPermissions(permissionKey) {
  const permission = await window.dappPermissions.getPermission(permissionKey);
  if (!permission) return;

  hideAllSubscreens();
  dappPermsKey = permissionKey;
  if (dappPermsSite) dappPermsSite.textContent = permissionKey;

  if (dappPermsSigningToggle) {
    dappPermsSigningToggle.checked = permission.autoApprove?.signing === true;
  }

  renderTxRules(permission.autoApprove?.transactions || []);

  walletState.identityView?.classList.add('hidden');
  dappPermsScreen?.classList.remove('hidden');
  openSidebarPanel();
}

function renderTxRules(rules) {
  if (!dappPermsTxList) return;

  if (!rules.length) {
    dappPermsTxList.innerHTML = '<div class="perms-empty">No auto-approved calls</div>';
    return;
  }

  dappPermsTxList.innerHTML = '';
  for (const rule of rules) {
    const row = document.createElement('div');
    row.className = 'perms-tx-rule';

    const info = document.createElement('div');
    info.className = 'perms-tx-info';

    const addr = document.createElement('code');
    addr.className = 'perms-tx-addr';
    addr.textContent = `${rule.to.slice(0, 10)}...${rule.to.slice(-6)}`;
    addr.title = rule.to;

    const sel = document.createElement('code');
    sel.className = 'perms-tx-selector';
    sel.textContent = rule.selector;

    const chain = document.createElement('span');
    chain.className = 'perms-tx-chain';
    chain.textContent = `chain ${rule.chainId}`;

    info.appendChild(addr);
    info.appendChild(sel);
    info.appendChild(chain);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'perms-tx-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await window.dappPermissions.removeTransactionAutoApprove(
        dappPermsKey, rule.to, rule.selector, rule.chainId
      );
      const updated = await window.dappPermissions.getPermission(dappPermsKey);
      renderTxRules(updated?.autoApprove?.transactions || []);
      updateConnectionBanner(dappPermsKey);
    });

    row.appendChild(info);
    row.appendChild(removeBtn);
    dappPermsTxList.appendChild(row);
  }
}

export function closeDappPerms() {
  dappPermsScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  dappPermsKey = null;
}

async function handleDappDisconnect() {
  if (!dappPermsKey) return;
  await disconnectDapp(dappPermsKey);
  closeDappPerms();
}

export async function showSwarmPermissions(permissionKey, options = {}) {
  const permission = await window.swarmPermissions.getPermission(permissionKey);
  if (!permission) return;

  const unlocked = await ensurePublisherIdentityUnlocked(permissionKey);
  if (!unlocked) {
    return;
  }

  hideAllSubscreens();
  swarmPermsKey = permissionKey;
  if (swarmPermsSite) swarmPermsSite.textContent = permissionKey;

  if (swarmPermsPublishToggle) {
    swarmPermsPublishToggle.checked = permission.autoApprove?.publish === true;
  }
  if (swarmPermsFeedsToggle) {
    swarmPermsFeedsToggle.checked = permission.autoApprove?.feeds === true;
  }
  await refreshSwarmIdentitySection();

  walletState.identityView?.classList.add('hidden');
  swarmPermsScreen?.classList.remove('hidden');
  openSidebarPanel();

  if (options.focusIdentity) {
    document.getElementById('swarm-perms-identity-section')?.scrollIntoView({ block: 'nearest' });
  }
}

export function closeSwarmPerms() {
  swarmPermsScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  swarmPermsKey = null;
  swarmPermsIdentityState = null;
  if (swarmPermsIdentitySelector) swarmPermsIdentitySelector.innerHTML = '';
  if (swarmPermsIdentityNote) {
    swarmPermsIdentityNote.textContent = '';
    swarmPermsIdentityNote.classList.add('hidden');
  }
}

async function handleSwarmDisconnect() {
  if (!swarmPermsKey) return;
  await disconnectSwarmApp(swarmPermsKey);
  closeSwarmPerms();
}

async function ensurePublisherIdentityUnlocked(permissionKey) {
  try {
    const status = await window.identity.getStatus();
    if (status.isUnlocked) return true;
    await showVaultUnlock(permissionKey);
    return true;
  } catch {
    return false;
  }
}

async function refreshSwarmIdentitySection(note = '') {
  if (!swarmPermsKey) return;
  try {
    swarmPermsIdentityState = await loadOrCreateIdentityState(swarmPermsKey);
  } catch (err) {
    console.error('[PermissionManage] Failed to load Swarm identities:', err);
    swarmPermsIdentityState = null;
  }
  renderSwarmIdentitySection(note);
}

async function loadOrCreateIdentityState(origin) {
  let state = await window.swarmFeedStore.getOriginIdentities(origin);
  if (!state?.activeIdentityId) {
    state = await window.swarmFeedStore.createAppScopedIdentity(origin);
  }
  return state;
}

function renderSwarmIdentitySection(note) {
  renderPublisherIdentitySelector(swarmPermsIdentitySelector, swarmPermsIdentityState, {
    onSelect: (identity) => activateSwarmIdentity(identity),
    onCreateAppScoped: () => createSwarmAppScopedIdentity(),
  });

  if (swarmPermsIdentityNote) {
    swarmPermsIdentityNote.textContent = note;
    swarmPermsIdentityNote.classList.toggle('hidden', !note);
  }
}

async function disableFeedAutoApprove() {
  if (!swarmPermsKey) return;
  await window.swarmPermissions.setAutoApprove(swarmPermsKey, 'feeds', false);
  if (swarmPermsFeedsToggle) swarmPermsFeedsToggle.checked = false;
  updateSwarmConnectionBanner(swarmPermsKey);
}

async function activateSwarmIdentity(identity) {
  if (!swarmPermsKey || !identity) return;
  if (identity.id === swarmPermsIdentityState?.activeIdentityId) return;

  if (identity.id === BEE_WALLET_IDENTITY_ID) {
    swarmPermsIdentityState = await window.swarmFeedStore.ensureBeeWalletIdentity(swarmPermsKey, { activate: true });
  } else if (identity.mode === 'ethereum-wallet') {
    swarmPermsIdentityState = await window.swarmFeedStore.ensureEthereumWalletIdentity(
      swarmPermsKey,
      identity.walletIndex,
      { activate: true }
    );
  } else {
    swarmPermsIdentityState = await window.swarmFeedStore.activateFeedIdentity(swarmPermsKey, identity.id);
  }
  await disableFeedAutoApprove();
  renderSwarmIdentitySection(`${identityLabel(getActivePublisherIdentity(swarmPermsIdentityState))} is now active. Feed auto-approve was turned off.`);
}

async function createSwarmAppScopedIdentity() {
  if (!swarmPermsKey) return;
  swarmPermsScreen?.classList.add('hidden');
  try {
    const state = await showPublisherIdentityCreate(swarmPermsKey);
    swarmPermsScreen?.classList.remove('hidden');
    if (state) {
      swarmPermsIdentityState = state;
      await disableFeedAutoApprove();
      renderSwarmIdentitySection(`${identityLabel(getActivePublisherIdentity(state))} was created and selected. Feed auto-approve was turned off.`);
    } else {
      await refreshSwarmIdentitySection();
    }
  } catch (err) {
    console.error('[PermissionManage] Publisher identity creation dismissed:', err);
    closeSwarmPerms();
  }
}
