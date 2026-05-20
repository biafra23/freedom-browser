/**
 * x402 Payment Approval Module
 *
 * Sidebar sub-screen for "this page wants $X to load." Triggered by the
 * `x402:approval-needed` event from main when the webRequest detector
 * sees a 402 the user hasn't pre-authorised. Same shape as dapp-tx.js /
 * dapp-sign.js: hide all sub-screens, render the card, await Approve or
 * Reject, IPC back to main.
 *
 * Auto-pay (an active per-origin cap covers the charge) is handled
 * entirely in main — this module never fires for that case.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { open as openSidebarPanel } from '../sidebar.js';
import { formatRawTokenBalance, truncateAddress, toAtomicUnits } from './wallet-utils.js';

// Defaults from the WP0 consent decision. The interstitial offers
// these via the grant toggle; main signs+stores the cap if the toggle
// stays checked when the user clicks Pay.
const DEFAULT_GRANT_CAP_USDC = 10;
const DEFAULT_GRANT_WINDOW_SECONDS = 30 * 24 * 60 * 60;

// DOM references
let screen;
let backBtn;
let siteEl;
let amountEl;
let toEl;
let networkEl;
let urlEl;
let warningEl;
let warningTextEl;
let unlockBlock;
let touchIdBtn;
let passwordLink;
let passwordSection;
let passwordInput;
let passwordSubmit;
let unlockError;
let errorEl;
let grantRow;
let grantToggle;
let grantCapEl;
let rejectBtn;
let approveBtn;

// Approval state for the currently-displayed card. `null` when idle.
let pending = null;

export function initDappX402() {
  screen = document.getElementById('sidebar-x402-approval');
  backBtn = document.getElementById('x402-approval-back');
  siteEl = document.getElementById('x402-approval-site');
  amountEl = document.getElementById('x402-approval-amount');
  toEl = document.getElementById('x402-approval-to');
  networkEl = document.getElementById('x402-approval-network');
  urlEl = document.getElementById('x402-approval-url');
  warningEl = document.getElementById('x402-approval-warning');
  warningTextEl = document.getElementById('x402-approval-warning-text');
  unlockBlock = document.getElementById('x402-approval-unlock');
  touchIdBtn = document.getElementById('x402-approval-touchid-btn');
  passwordLink = document.getElementById('x402-approval-password-link');
  passwordSection = document.getElementById('x402-approval-password-section');
  passwordInput = document.getElementById('x402-approval-password-input');
  passwordSubmit = document.getElementById('x402-approval-password-submit');
  unlockError = document.getElementById('x402-approval-unlock-error');
  errorEl = document.getElementById('x402-approval-error');
  grantRow = document.getElementById('x402-approval-grant-row');
  grantToggle = document.getElementById('x402-approval-grant-toggle');
  grantCapEl = document.getElementById('x402-approval-grant-cap');
  rejectBtn = document.getElementById('x402-approval-reject');
  approveBtn = document.getElementById('x402-approval-approve');

  registerScreenHider(() => screen?.classList.add('hidden'));
  wireButtons();

  // Subscribe to main's "approval needed" events. Returned disposer is
  // discarded — the renderer lives for the window's lifetime.
  window.electronAPI?.onX402ApprovalNeeded?.((payload) => {
    showApproval(payload).catch((err) => {
      console.error('[x402] failed to show approval:', err);
    });
  });
}

function wireButtons() {
  backBtn?.addEventListener('click', reject);
  rejectBtn?.addEventListener('click', reject);
  approveBtn?.addEventListener('click', approve);

  touchIdBtn?.addEventListener('click', handleTouchIdUnlock);
  passwordSubmit?.addEventListener('click', handlePasswordUnlock);
  passwordInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handlePasswordUnlock();
  });
  passwordLink?.addEventListener('click', () => {
    passwordLink.classList.add('hidden');
    passwordSection?.classList.remove('hidden');
    passwordInput?.focus();
  });
}

async function showApproval({ webContentsId, url, requirements }) {
  // Re-fetch the canonical details via IPC so the sidebar trusts main's
  // view (including the asset lookup against our allowlist). We only
  // use the event's `url` + `webContentsId` as routing context.
  const details = await window.electronAPI.x402GetDetails({ webContentsId });
  if (!details?.success) {
    console.warn('[x402] approval-needed event for an unknown tab:', details?.error);
    return;
  }

  pending = {
    webContentsId,
    url: details.url ?? url,
    requirements: details.requirements ?? requirements,
    asset: details.asset,
    autoPay: details.autoPay,
  };

  renderCard();
  await checkUnlockState();

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
  openSidebarPanel();
}

function renderCard() {
  const accept = pending.requirements?.accepts?.[0] || {};
  const asset = pending.asset;
  const rawAmount = accept.amount ?? accept.maxAmountRequired ?? '';

  let origin;
  try { origin = new URL(pending.url).origin; } catch { origin = pending.url; }
  siteEl.textContent = origin;
  urlEl.textContent = pending.url;
  urlEl.title = pending.url;
  toEl.textContent = truncateAddress(accept.payTo || '');
  toEl.title = accept.payTo || '';
  networkEl.textContent = String(accept.network || '—');

  if (asset && typeof asset.decimals === 'number') {
    const pretty = formatRawTokenBalance(rawAmount, asset.decimals);
    amountEl.textContent = `${pretty} ${asset.symbol}`;
    grantCapEl.textContent = `${DEFAULT_GRANT_CAP_USDC} ${asset.symbol}`;
    grantRow.classList.remove('hidden');
    pending.grantPayload = {
      capAmount: toAtomicUnits(DEFAULT_GRANT_CAP_USDC, asset.decimals),
      windowSeconds: DEFAULT_GRANT_WINDOW_SECONDS,
    };
    approveBtn.disabled = false;
    hideError();
  } else {
    amountEl.textContent = `${rawAmount} of ${truncateAddress(accept.asset || '')}`;
    grantRow.classList.add('hidden');
    pending.grantPayload = null;
    approveBtn.disabled = true;
    showError('This site asks for payment in an asset we don’t recognise.');
  }

  // Surface an over-cap warning so the user knows their existing
  // allowance won't quietly auto-cover this charge.
  if (pending.autoPay?.kind === 'over-cap') {
    warningTextEl.textContent =
      'This charge exceeds your remaining allowance for this site; approving will reset the allowance for the next 30 days.';
    warningEl.classList.remove('hidden');
  } else {
    warningEl.classList.add('hidden');
  }
}

async function checkUnlockState() {
  try {
    const status = await window.identity?.getStatus?.();
    const unlocked = status?.isUnlocked;
    unlockBlock?.classList.toggle('hidden', !!unlocked);
    if (approveBtn) approveBtn.disabled = !unlocked || !pending?.grantPayload;
  } catch {
    unlockBlock?.classList.remove('hidden');
    if (approveBtn) approveBtn.disabled = true;
  }
}

async function handleTouchIdUnlock() {
  try {
    // Same incantation dapp-tx.js uses: quickUnlock returns the cached
    // password from the keychain, then identity.unlock applies it.
    const result = await window.quickUnlock.unlock();
    if (!result?.success) throw new Error(result?.error || 'Touch ID failed');
    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult?.success) throw new Error(unlockResult?.error || 'Failed to unlock vault');
    hideUnlockError();
    await checkUnlockState();
  } catch (err) {
    if (err?.message !== 'Touch ID cancelled') {
      showUnlockError(err?.message || 'Touch ID failed');
    }
  }
}

async function handlePasswordUnlock() {
  const password = passwordInput?.value;
  if (!password) return;
  try {
    const result = await window.identity.unlock(password);
    if (!result?.success) throw new Error(result?.error || 'Incorrect password');
    if (passwordInput) passwordInput.value = '';
    hideUnlockError();
    await checkUnlockState();
  } catch (err) {
    showUnlockError(err?.message || 'Failed to unlock');
  }
}

async function approve() {
  if (!pending) return;
  approveBtn.disabled = true;
  rejectBtn.disabled = true;
  approveBtn.textContent = 'Signing…';
  hideError();

  const grant = grantToggle?.checked && pending.grantPayload ? pending.grantPayload : undefined;
  const result = await window.electronAPI.x402Approve({
    webContentsId: pending.webContentsId,
    grant,
  });

  if (result?.success) {
    closeAndReset();
    return;
  }

  approveBtn.textContent = 'Pay';
  approveBtn.disabled = false;
  rejectBtn.disabled = false;
  showError(result?.error || 'Payment failed.');
  // Common case: vault locked between render and click; re-check state.
  if (/locked/i.test(result?.error || '')) {
    checkUnlockState();
  }
}

async function reject() {
  if (!pending) {
    closeAndReset();
    return;
  }
  const id = pending.webContentsId;
  closeAndReset();
  try {
    await window.electronAPI.x402Cancel({ webContentsId: id });
  } catch (err) {
    console.error('[x402] cancel failed:', err);
  }
}

function closeAndReset() {
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  pending = null;
  approveBtn.textContent = 'Pay';
  approveBtn.disabled = false;
  rejectBtn.disabled = false;
  hideError();
  hideUnlockError();
  if (passwordInput) passwordInput.value = '';
}

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl?.classList.add('hidden');
  if (errorEl) errorEl.textContent = '';
}

function showUnlockError(message) {
  if (!unlockError) return;
  unlockError.textContent = message;
  unlockError.classList.remove('hidden');
}

function hideUnlockError() {
  unlockError?.classList.add('hidden');
  if (unlockError) unlockError.textContent = '';
}
