// Payments tab — recent x402 receipts + active per-origin allowances.
// Data lives in main (x402-receipts.json, x402-permissions.json); this
// module just renders and wires the Revoke button.

import { formatRawTokenBalance, truncateAddress, escapeHtml } from './wallet-utils.js';

const allowancesEl = () => document.getElementById('x402-allowances-list');
const receiptsEl = () => document.getElementById('x402-receipts-list');

// Module-level cache of chain + token metadata so we don't hit the
// IPCs for every receipt. Re-fetched on each refresh — fresh enough
// for a manually-opened sidebar tab.
let chainsById = {};
let tokensByChainAndAddress = {};

async function loadChainAndTokenMeta(chainIds) {
  chainsById = {};
  tokensByChainAndAddress = {};
  await Promise.all(chainIds.map(async (chainId) => {
    try {
      const [chain, tokens] = await Promise.all([
        window.networks?.getChain?.(chainId),
        window.tokens?.getTokens?.(chainId),
      ]);
      if (chain) chainsById[chainId] = chain;
      if (tokens) {
        for (const tok of Object.values(tokens)) {
          if (tok.address) {
            tokensByChainAndAddress[`${chainId}:${tok.address.toLowerCase()}`] = tok;
          }
        }
      }
    } catch (err) {
      console.warn('[payments] chain/token meta lookup failed:', err);
    }
  }));
}

function tokenFor(chainId, asset) {
  return tokensByChainAndAddress[`${chainId}:${String(asset).toLowerCase()}`] ?? null;
}

function formatAmountFor(chainId, asset, atomic) {
  const tok = tokenFor(chainId, asset);
  if (!tok) return `${atomic} of ${truncateAddress(asset)}`;
  const formatted = formatRawTokenBalance(atomic, tok.decimals);
  return `${formatted} ${tok.symbol}`;
}

function txExplorerUrl(chainId, txHash) {
  const chain = chainsById[chainId];
  if (!chain?.blockExplorer || !txHash) return null;
  return `${chain.blockExplorer}/tx/${txHash}`;
}

// 1700000000 → "May 19" / "yesterday" / "5 minutes ago" — keep it
// brief; the receipts list is dense.
function formatRelative(unixSeconds) {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 60 * 60) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 24 * 60 * 60) return `${Math.floor(diff / (60 * 60))} hr ago`;
  if (diff < 7 * 24 * 60 * 60) return `${Math.floor(diff / (24 * 60 * 60))} d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function setListContent(container, html, emptyMessage) {
  if (!container) return;
  container.innerHTML = html || `<div class="x402-empty">${emptyMessage}</div>`;
}

// === Allowances ==========================================================

function renderAllowances(permissions) {
  const container = allowancesEl();
  if (!container) return;
  if (!permissions.length) {
    setListContent(container, '', 'No active allowances.');
    return;
  }
  const rows = permissions.map((perm) => {
    const tok = tokenFor(perm.chainId, perm.asset);
    const cap = tok
      ? `${formatRawTokenBalance(perm.capAmount, tok.decimals)} ${tok.symbol}`
      : `${perm.capAmount} of ${truncateAddress(perm.asset)}`;
    const spent = tok
      ? `${formatRawTokenBalance(perm.spentAmount, tok.decimals)} ${tok.symbol}`
      : `${perm.spentAmount}`;
    const expiresIn = perm.expiresAt - Math.floor(Date.now() / 1000);
    const expiryLabel = expiresIn > 0
      ? `expires in ${Math.ceil(expiresIn / (24 * 60 * 60))} d`
      : 'expired';

    return `
      <div class="x402-row">
        <div class="x402-row-main">
          <div class="x402-origin">${escapeHtml(perm.origin)}</div>
          <div class="x402-meta">${escapeHtml(spent)} of ${escapeHtml(cap)} · ${expiryLabel}</div>
        </div>
        <button class="x402-revoke" data-origin="${escapeHtml(perm.origin)}" data-chain-id="${perm.chainId}" data-asset="${escapeHtml(perm.asset)}">Revoke</button>
      </div>
    `;
  }).join('');
  setListContent(container, rows, 'No active allowances.');

  // Wire revoke buttons after render.
  container.querySelectorAll('.x402-revoke').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await window.electronAPI.x402RevokePermission({
        origin: btn.dataset.origin,
        chainId: Number(btn.dataset.chainId),
        asset: btn.dataset.asset,
      });
      // Refresh the panel so the row vanishes and the receipt list still
      // reflects the prior payments (those don't get revoked by this).
      refreshPayments();
    });
  });
}

// === Receipts ============================================================

const STATUS_LABEL = {
  settled: 'Paid',
  'no-receipt': 'Pending',
  failed: 'Failed',
};

function renderReceipts(receipts) {
  const container = receiptsEl();
  if (!container) return;
  if (!receipts.length) {
    setListContent(container, '', 'No payments yet.');
    return;
  }
  const rows = receipts.map((r) => {
    const amount = formatAmountFor(r.chainId, r.asset, r.amount);
    const txUrl = txExplorerUrl(r.chainId, r.txHash);
    const txLink = txUrl
      ? `<a class="x402-tx" href="${escapeHtml(txUrl)}" target="_blank" rel="noopener">${truncateAddress(r.txHash)}</a>`
      : r.txHash ? `<span class="x402-tx">${truncateAddress(r.txHash)}</span>` : '';
    return `
      <div class="x402-row">
        <div class="x402-row-main">
          <div class="x402-origin">${escapeHtml(r.origin || r.url)}</div>
          <div class="x402-meta">${escapeHtml(amount)} · ${formatRelative(r.settledAt)} ${txLink}</div>
        </div>
        <div class="x402-status x402-status--${escapeHtml(r.status)}">${escapeHtml(STATUS_LABEL[r.status] ?? r.status)}</div>
      </div>
    `;
  }).join('');
  setListContent(container, rows, 'No payments yet.');
}

// === Public refresh entry point ==========================================

export async function refreshPayments() {
  // Concurrent refreshes race; whichever resolves last wins the DOM.
  // We don't coalesce because a refresh triggered RIGHT AFTER a mutation
  // (e.g. revoke) needs to see post-mutation state — coalescing here
  // returned the pre-mutation snapshot to the post-mutation caller.
  // Data sizes (≤200 entries, ≤handful of chains) make the duplicate
  // IPC cost negligible.
  try {
    const [permsResult, receiptsResult] = await Promise.all([
      window.electronAPI.x402GetAllPermissions(),
      window.electronAPI.x402GetReceipts({ limit: 200 }),
    ]);
    const permissions = permsResult?.permissions ?? [];
    const receipts = receiptsResult?.receipts ?? [];

    const chainIds = new Set();
    permissions.forEach((p) => chainIds.add(p.chainId));
    receipts.forEach((r) => chainIds.add(r.chainId));
    await loadChainAndTokenMeta([...chainIds]);

    renderAllowances(permissions);
    renderReceipts(receipts);
  } catch (err) {
    console.error('[payments] refresh failed:', err);
  }
}

export function initPayments() {
  // Render once at boot in case the user opens the tab before any
  // refresh trigger fires. Cheap when both lists are empty.
  refreshPayments();
}
