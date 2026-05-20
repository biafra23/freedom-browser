/**
 * Permission Management Subscreens
 *
 * Per-site permission management for wallet and Swarm connections.
 * Accessible by clicking the connection banner info area.
 */

import { walletState, hideAllSubscreens } from './wallet-state.js';
import { open as openSidebarPanel } from '../sidebar.js';
import { updateConnectionBanner, disconnectDapp } from './dapp-connect.js';
import { updateSwarmConnectionBanner, disconnectSwarmApp } from './swarm-connect.js';
import { updateX402ConnectionBanner, disconnectX402 } from './dapp-x402.js';
import { formatRawTokenBalance, toAtomicUnits } from './wallet-utils.js';

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
let swarmPermsDisconnect;
let swarmPermsKey = null;

// x402 permission management
let x402PermsScreen;
let x402PermsBack;
let x402PermsSite;
let x402PermsList;
let x402PermsRevokeAll;
let x402PermsKey = null;

// Window-selector options. Values in seconds; labels stay user-friendly.
const X402_WINDOW_OPTIONS = [
  { label: '1 day',    seconds: 24 * 60 * 60 },
  { label: '7 days',   seconds: 7 * 24 * 60 * 60 },
  { label: '30 days',  seconds: 30 * 24 * 60 * 60 },
  { label: '90 days',  seconds: 90 * 24 * 60 * 60 },
  { label: '1 year',   seconds: 365 * 24 * 60 * 60 },
];

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
  swarmPermsDisconnect = document.getElementById('swarm-perms-disconnect');

  swarmPermsBack?.addEventListener('click', closeSwarmPerms);
  swarmPermsDisconnect?.addEventListener('click', handleSwarmDisconnect);
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

  // x402 permission screen
  x402PermsScreen = document.getElementById('sidebar-x402-permissions');
  x402PermsBack = document.getElementById('x402-perms-back');
  x402PermsSite = document.getElementById('x402-perms-site');
  x402PermsList = document.getElementById('x402-perms-list');
  x402PermsRevokeAll = document.getElementById('x402-perms-revoke-all');

  x402PermsBack?.addEventListener('click', closeX402Perms);
  x402PermsRevokeAll?.addEventListener('click', handleX402RevokeAll);
}

export async function showDappPermissions(permissionKey) {
  dappPermsKey = permissionKey;
  if (dappPermsSite) dappPermsSite.textContent = permissionKey;

  const permission = await window.dappPermissions.getPermission(permissionKey);
  if (!permission) return;

  if (dappPermsSigningToggle) {
    dappPermsSigningToggle.checked = permission.autoApprove?.signing === true;
  }

  renderTxRules(permission.autoApprove?.transactions || []);

  hideAllSubscreens();
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

function closeDappPerms() {
  dappPermsScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  dappPermsKey = null;
}

async function handleDappDisconnect() {
  if (!dappPermsKey) return;
  await disconnectDapp(dappPermsKey);
  closeDappPerms();
}

export async function showSwarmPermissions(permissionKey) {
  swarmPermsKey = permissionKey;
  if (swarmPermsSite) swarmPermsSite.textContent = permissionKey;

  const permission = await window.swarmPermissions.getPermission(permissionKey);
  if (!permission) return;

  if (swarmPermsPublishToggle) {
    swarmPermsPublishToggle.checked = permission.autoApprove?.publish === true;
  }
  if (swarmPermsFeedsToggle) {
    swarmPermsFeedsToggle.checked = permission.autoApprove?.feeds === true;
  }

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  swarmPermsScreen?.classList.remove('hidden');
  openSidebarPanel();
}

function closeSwarmPerms() {
  swarmPermsScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  swarmPermsKey = null;
}

async function handleSwarmDisconnect() {
  if (!swarmPermsKey) return;
  await disconnectSwarmApp(swarmPermsKey);
  closeSwarmPerms();
}

export async function showX402Permissions(originKey) {
  x402PermsKey = originKey;
  if (x402PermsSite) x402PermsSite.textContent = originKey;

  await renderX402Permissions();

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  x402PermsScreen?.classList.remove('hidden');
  openSidebarPanel();
}

async function renderX402Permissions() {
  if (!x402PermsList || !x402PermsKey) return;

  const result = await window.electronAPI.x402GetAllPermissions();
  const perms = (result?.permissions || []).filter((p) => p.origin === x402PermsKey);

  if (perms.length === 0) {
    x402PermsList.innerHTML = '<div class="perms-empty">No active auto-pay caps for this site.</div>';
    return;
  }

  // Resolve asset + chain metadata for each cap in parallel — needed for
  // human-readable amounts and chain names. Both IPCs return envelopes
  // (`{success, token}` / `{success, chain}`); unwrap them here.
  const blocks = await Promise.all(
    perms.map(async (perm) => {
      const [tokenResult, chainResult] = await Promise.all([
        window.tokens.getToken(`${perm.chainId}:${perm.asset}`),
        window.networks.getChain(perm.chainId),
      ]);
      return buildX402PermBlock(perm, tokenResult?.token, chainResult?.chain);
    })
  );

  x402PermsList.innerHTML = '';
  for (const block of blocks) x402PermsList.appendChild(block);
}

function buildX402PermBlock(perm, asset, chain) {
  const block = document.createElement('div');
  block.className = 'x402-perm-block';

  // Missing asset metadata means we can't safely format amounts or let
  // the user edit the cap. Surface a friendly placeholder and a hint to
  // refresh the wallet view rather than the raw atomic units.
  if (!asset || typeof asset.decimals !== 'number') {
    block.appendChild(buildPermHeader('Unknown asset', chain));
    const meta = document.createElement('div');
    meta.className = 'x402-perm-meta';
    meta.textContent = 'This cap is for a token your wallet hasn’t indexed yet. Reload the wallet to refresh.';
    block.appendChild(meta);
    return block;
  }

  const { symbol, decimals } = asset;
  block.appendChild(buildPermHeader(symbol, chain));
  block.appendChild(buildUsageBar(perm, decimals, symbol));
  block.appendChild(buildExpiryLine(perm));
  block.appendChild(buildEditDivider());
  block.appendChild(buildCapField(perm, decimals, symbol));
  block.appendChild(buildWindowField(perm));
  return block;
}

function buildPermHeader(symbol, chain) {
  const header = document.createElement('div');
  header.className = 'x402-perm-header';

  const name = document.createElement('span');
  name.className = 'x402-perm-asset-name';
  name.textContent = symbol;

  const chainBadge = document.createElement('span');
  chainBadge.className = 'x402-perm-chain-badge';
  chainBadge.textContent = chain?.name || chain?.shortName || `chain ${chain?.chainId ?? '?'}`;

  header.appendChild(name);
  header.appendChild(chainBadge);
  return header;
}

function buildUsageBar(perm, decimals, symbol) {
  const wrap = document.createElement('div');
  wrap.className = 'x402-perm-usage';

  const cap = BigInt(perm.capAmount);
  const spent = BigInt(perm.spentAmount);
  const pct = cap > 0n ? Number((spent * 1000n) / cap) / 10 : 0;

  const bar = document.createElement('div');
  bar.className = 'x402-perm-bar';
  const fill = document.createElement('div');
  fill.className = 'x402-perm-bar-fill';
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  bar.appendChild(fill);

  const summary = document.createElement('div');
  summary.className = 'x402-perm-usage-summary';
  summary.textContent =
    `${formatHumanAmount(spent.toString(), decimals)} of ${formatHumanAmount(cap.toString(), decimals)} ${symbol} spent`;

  wrap.appendChild(summary);
  wrap.appendChild(bar);
  return wrap;
}

function buildExpiryLine(perm) {
  const line = document.createElement('div');
  line.className = 'x402-perm-expiry';
  const expiresAtMs = perm.expiresAt * 1000;
  const absolute = new Date(expiresAtMs).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  const secondsLeft = perm.expiresAt - Math.floor(Date.now() / 1000);
  line.textContent = `Resets ${absolute} (${formatRelativeFuture(secondsLeft)})`;
  return line;
}

function buildEditDivider() {
  const div = document.createElement('div');
  div.className = 'x402-perm-divider';
  div.textContent = 'Adjust';
  return div;
}

function buildCapField(perm, decimals, symbol) {
  const capField = document.createElement('div');
  capField.className = 'x402-perm-field';
  const capLabel = document.createElement('label');
  capLabel.textContent = 'Spend cap';
  const capWrap = document.createElement('div');
  capWrap.className = 'x402-perm-input-wrap';
  const capInput = document.createElement('input');
  capInput.type = 'number';
  capInput.min = '0';
  capInput.step = '1';
  capInput.className = 'x402-perm-input';
  capInput.value = atomicToWhole(perm.capAmount, decimals);
  capInput.addEventListener('change', async () => {
    const whole = capInput.value.trim();
    if (!/^\d+$/.test(whole) || whole === '0') {
      capInput.value = atomicToWhole(perm.capAmount, decimals);
      return;
    }
    await saveX402Patch(perm, { capAmount: toAtomicUnits(whole, decimals) });
  });
  const suffix = document.createElement('span');
  suffix.className = 'x402-perm-input-suffix';
  suffix.textContent = symbol;
  capWrap.appendChild(capInput);
  capWrap.appendChild(suffix);
  capField.appendChild(capLabel);
  capField.appendChild(capWrap);
  return capField;
}

function buildWindowField(perm) {
  const windowField = document.createElement('div');
  windowField.className = 'x402-perm-field';
  const windowLabel = document.createElement('label');
  windowLabel.textContent = 'Resets every';
  const windowSelect = document.createElement('select');
  windowSelect.className = 'x402-perm-select';
  const currentWindow = perm.expiresAt - perm.createdAt;
  for (const opt of X402_WINDOW_OPTIONS) {
    const o = document.createElement('option');
    o.value = String(opt.seconds);
    o.textContent = opt.label;
    if (opt.seconds === currentWindow) o.selected = true;
    windowSelect.appendChild(o);
  }
  windowSelect.addEventListener('change', async () => {
    await saveX402Patch(perm, { windowSeconds: Number(windowSelect.value) });
  });
  windowField.appendChild(windowLabel);
  windowField.appendChild(windowSelect);
  return windowField;
}

// Whole-unit view of an atomic-units string ("10000000" with 6 decimals → "10").
// Truncates fractional sub-units; the cap input only accepts whole units so
// round-tripping stays lossless.
function atomicToWhole(atomic, decimals) {
  const formatted = formatRawTokenBalance(atomic, decimals);
  if (formatted === '--') return '0';
  return formatted.split('.')[0].replace(/,/g, '');
}

function formatHumanAmount(atomic, decimals) {
  const formatted = formatRawTokenBalance(atomic, decimals);
  return formatted === '--' ? '0' : formatted;
}

// Relative "in N days / hours" for future-only seconds. Negative input
// shouldn't happen — expired records are compacted in main on read —
// but fall back to "soon" rather than rendering "-1 days".
function formatRelativeFuture(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 60) return 'soon';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `in ${days} days`;
  const months = Math.floor(days / 30);
  if (months < 24) return `in ${months} month${months === 1 ? '' : 's'}`;
  return `in ${Math.floor(months / 12)} years`;
}

async function saveX402Patch(perm, patch) {
  await window.electronAPI.x402UpdatePermission({
    origin: perm.origin,
    chainId: perm.chainId,
    asset: perm.asset,
    ...patch,
  });
  // The detail subscreen and the wallet-tab banner both need a refreshed
  // view; fire them concurrently rather than awaiting sequentially.
  await Promise.all([
    renderX402Permissions(),
    updateX402ConnectionBanner(x402PermsKey),
  ]);
}

function closeX402Perms() {
  x402PermsScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  x402PermsKey = null;
}

async function handleX402RevokeAll() {
  if (!x402PermsKey) return;
  await disconnectX402(x402PermsKey);
  closeX402Perms();
}
