/**
 * x402 Payment Approval Module
 *
 * Two responsibilities, mirroring dapp-connect.js's split:
 *
 *   1. The "this page wants $X to load" sidebar sub-screen, triggered by
 *      the `x402:approval-needed` event from main when the webRequest
 *      detector sees a 402 the user hasn't pre-authorised. Same shape as
 *      dapp-tx.js / dapp-sign.js: hide all sub-screens, render the card,
 *      await Approve or Reject, IPC back to main.
 *
 *   2. The auto-pay connection banner at the top of the Wallet tab. When
 *      the current site has an active x402 cap, the banner shows it (with
 *      remaining headroom) and offers a × button to revoke everything for
 *      the origin, or a click to open the detail subscreen for fine
 *      adjustment. Mirrors dapp-connection-banner / swarm-connection-banner.
 *
 * Auto-pay (an active per-origin cap covers the charge) is handled
 * entirely in main — the approval card never fires for that case.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from '../sidebar.js';
import { formatRawTokenBalance, truncateAddress, toAtomicUnits } from './wallet-utils.js';
import { getPermissionKey } from '../origin-utils.js';
import { showX402Permissions } from './permission-manage.js';
import { showVaultUnlock } from './vault-unlock.js';

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

let bannerEl;
let bannerInfoEl;
let bannerSiteEl;
let bannerRemainingEl;
let bannerDisconnectBtn;

// Origin key currently displayed in the banner; cleared when hidden.
let currentBannerKey = null;

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

  bannerEl = document.getElementById('x402-connection-banner');
  bannerInfoEl = document.getElementById('x402-connection-manage');
  bannerSiteEl = document.getElementById('x402-connection-site');
  bannerRemainingEl = document.getElementById('x402-connection-remaining');
  bannerDisconnectBtn = document.getElementById('x402-connection-disconnect');

  registerScreenHider(() => screen?.classList.add('hidden'));
  wireButtons();
  wireBanner();

  // Subscribe to main's "approval needed" events. Returned disposer is
  // discarded — the renderer lives for the window's lifetime.
  window.electronAPI?.onX402ApprovalNeeded?.((payload) => {
    showApproval(payload).catch((err) => {
      console.error('[x402] failed to show approval:', err);
    });
  });

  // Subresource sign-after-approve completion. The IPC approve handler
  // returns `pending: true` for subresource — the card stays in
  // "Signing..." until this event arrives with success or error.
  window.electronAPI?.onX402ApprovalResult?.((payload) => {
    handleApprovalResult(payload);
  });

  // Vault-was-locked-during-auto-pay events. The cap was already granted,
  // so no permission card — just unlock and resume sign-flow via the
  // dedicated x402:resume-unlock IPC (NOT x402:approve — see
  // handleAutoPayUnlock for the source-separation rationale).
  window.electronAPI?.onX402UnlockNeeded?.(({ webContentsId, origin }) => {
    handleAutoPayUnlock(webContentsId, origin).catch((err) => {
      console.error('[x402] auto-pay unlock flow failed:', err);
    });
  });

  // Silent cap-covered auto-pay (video segments, lazy paragraphs, …)
  // doesn't round-trip through the renderer, so the banner's spend
  // counter would otherwise only refresh on navigation. Filter by
  // origin so multi-tab pays on other origins don't trigger a
  // full x402GetAllPermissions round-trip we'd just throw away.
  window.electronAPI?.onX402CapConsumed?.(({ origin } = {}) => {
    if (!isSidebarVisible() || origin !== currentBannerKey) return;
    updateX402ConnectionBanner().catch((err) => {
      console.error('[x402] banner refresh after cap-consumed failed:', err);
    });
  });
}

async function handleAutoPayUnlock(webContentsId, origin) {
  try {
    await showVaultUnlock(origin);
  } catch {
    // User cancelled the unlock; nothing to do — the original 402 page
    // stays rendered, the user can retry by navigating again. Main's
    // resume token expires via TTL.
    return;
  }
  // Dedicated resume channel — NOT x402Approve. The resume token in main
  // is consent-source-specific (CAP from the original auto-pay) and must
  // not be consumed by a manual approval click on a different charge.
  const result = await window.electronAPI.x402ResumeUnlock({ webContentsId });
  if (!result?.success) {
    console.error('[x402] resume-after-unlock failed:', result?.error);
  }
}

function wireBanner() {
  bannerInfoEl?.addEventListener('click', () => {
    if (currentBannerKey) {
      showX402Permissions(currentBannerKey);
    }
  });
  bannerDisconnectBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentBannerKey) {
      disconnectX402(currentBannerKey);
    }
  });

  // Refresh on sidebar open + after navigations finish, same as the
  // dapp/swarm banners — otherwise the banner only updates on explicit
  // tab switches and misses initial-load and in-tab navigation cases.
  document.addEventListener('sidebar-opened', () => {
    updateX402ConnectionBanner();
  });
  document.addEventListener('navigation-completed', () => {
    if (isSidebarVisible()) {
      updateX402ConnectionBanner();
    }
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

async function showApproval({ webContentsId, detectionId, url, requirements, resourceType }) {
  // Re-fetch the canonical details via IPC so the sidebar trusts main's
  // view (asset allowlist, autoPay state). detectionId routes to the
  // specific 402 we got the event for, immune to a newer detection
  // replacing detectedPayments[webContentsId] in main.
  const details = await window.electronAPI.x402GetDetails({ webContentsId, detectionId });
  if (!details?.success) {
    console.warn('[x402] approval-needed event for an unknown tab:', details?.error);
    return;
  }

  pending = {
    webContentsId,
    detectionId: details.detectionId ?? detectionId ?? null,
    resourceType: resourceType ?? null,
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
    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      unlockBlock?.classList.add('hidden');
      if (approveBtn) approveBtn.disabled = !pending?.grantPayload;
      return;
    }

    unlockBlock?.classList.remove('hidden');
    if (approveBtn) approveBtn.disabled = true;

    // Show Touch ID when available + enrolled, fall back to the password
    // link, and the section directly if the user doesn't yet have a
    // memorised password.
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const hasTouchId = canUseTouchId && touchIdEnabled;

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    touchIdBtn?.classList.toggle('hidden', !hasTouchId);

    if (hasTouchId && userKnowsPassword) {
      passwordLink?.classList.remove('hidden');
      passwordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      passwordLink?.classList.add('hidden');
      passwordSection?.classList.remove('hidden');
    } else {
      passwordLink?.classList.add('hidden');
      passwordSection?.classList.add('hidden');
    }
  } catch (err) {
    console.error('[x402] failed to check vault status:', err);
    unlockBlock?.classList.remove('hidden');
    touchIdBtn?.classList.add('hidden');
    passwordLink?.classList.add('hidden');
    passwordSection?.classList.remove('hidden');
  }
}

async function handleTouchIdUnlock() {
  try {
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
    detectionId: pending.detectionId,
    grant,
  });

  if (result?.success) {
    // Subresource path returns pending:true; card stays in "Signing..."
    // and handleApprovalResult finalises it. mainFrame path returns
    // success without pending — close immediately.
    if (result.pending) return;
    closeAndReset();
    updateX402ConnectionBanner().catch(() => {});
    return;
  }

  restoreCardWithError(result?.error);
}

// Restore the approval card to its clickable state and show an error.
// Used by both the synchronous mainFrame error path (in approve()) and
// the async subresource sign-after-approve failure (in
// handleApprovalResult). The locked-vault re-check is the non-obvious
// behaviour worth centralising — without it the unlock UI won't re-
// appear when the vault auto-locked between render and click.
function restoreCardWithError(error) {
  approveBtn.textContent = 'Pay';
  approveBtn.disabled = false;
  rejectBtn.disabled = false;
  showError(error || 'Payment failed.');
  if (/locked/i.test(error || '')) {
    checkUnlockState();
  }
}

// Finalises the subresource "Signing..." state when the detector's
// async sign completes. detectionId-match guards against a stale event
// for a previously-rendered card.
function handleApprovalResult({ detectionId, success, error }) {
  if (!pending || pending.detectionId !== detectionId) return;
  if (success) {
    closeAndReset();
    updateX402ConnectionBanner().catch(() => {});
    return;
  }
  restoreCardWithError(error);
}

async function reject() {
  if (!pending) {
    closeAndReset();
    return;
  }
  const id = pending.webContentsId;
  const detectionId = pending.detectionId;
  const isSubresource = pending.resourceType && pending.resourceType !== 'mainFrame';
  closeAndReset();
  try {
    if (isSubresource && detectionId) {
      // Subresource flow: settle the pending approval Promise so the
      // detector returns null and the page sees the 402. No webview
      // navigation — the user is still on whatever page initiated the
      // subresource fetch.
      await window.electronAPI.x402Reject({ detectionId });
    } else {
      // mainFrame paywall page: existing behaviour — clear detection
      // and navigate the webview back (or to about:blank if no history).
      await window.electronAPI.x402Cancel({ webContentsId: id });
    }
  } catch (err) {
    console.error('[x402] reject/cancel failed:', err);
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

/**
 * Refresh the auto-pay banner for the current address bar URL (or the
 * supplied origin key). Shows the banner iff there's at least one
 * active cap for that origin.
 */
export async function updateX402ConnectionBanner(originKey = null) {
  if (!bannerEl) return;

  let key = originKey;
  if (!key) {
    const displayUrl = document.getElementById('address-input')?.value || '';
    key = getPermissionKey(displayUrl);
  }

  if (!key) {
    bannerEl.classList.add('hidden');
    currentBannerKey = null;
    return;
  }

  try {
    const result = await window.electronAPI.x402GetAllPermissions();
    const forOrigin = (result?.permissions || []).filter((p) => p.origin === key);

    if (forOrigin.length === 0) {
      bannerEl.classList.add('hidden');
      currentBannerKey = null;
      return;
    }

    if (bannerSiteEl) bannerSiteEl.textContent = key;
    if (bannerRemainingEl) {
      bannerRemainingEl.textContent = await formatRemainingSummary(forOrigin);
    }
    currentBannerKey = key;
    bannerEl.classList.remove('hidden');
  } catch (err) {
    console.error('[x402] failed to refresh banner:', err);
    bannerEl.classList.add('hidden');
    currentBannerKey = null;
  }
}

// Render the per-origin remaining-cap summary. When every active cap is
// the same asset we can sum them and show "X SYMBOL left"; mixed assets
// or missing token-registry metadata fall back to a generic count (the
// detail subscreen breaks down per cap anyway).
async function formatRemainingSummary(perms) {
  // tokens:get-token returns an `{success, token}` envelope — unwrap it.
  const enriched = await Promise.all(
    perms.map(async (p) => {
      const r = await window.tokens.getToken(`${p.chainId}:${p.asset}`);
      return { perm: p, asset: r?.token ?? null };
    })
  );

  const symbols = new Set(enriched.map((e) => e.asset?.symbol).filter(Boolean));
  if (symbols.size === 1 && enriched[0].asset) {
    const { asset } = enriched[0];
    let remaining = 0n;
    for (const { perm } of enriched) {
      remaining += BigInt(perm.capAmount) - BigInt(perm.spentAmount);
    }
    if (remaining < 0n) remaining = 0n;
    return `${formatRawTokenBalance(remaining.toString(), asset.decimals)} ${asset.symbol} left`;
  }
  return `${perms.length} cap${perms.length > 1 ? 's' : ''} active`;
}

export async function disconnectX402(originKey) {
  const key = originKey || currentBannerKey;
  if (!key) return;
  try {
    await window.electronAPI.x402RevokeAllForOrigin({ origin: key });
    bannerEl?.classList.add('hidden');
    currentBannerKey = null;
  } catch (err) {
    console.error('[x402] revoke-all failed:', err);
  }
}
