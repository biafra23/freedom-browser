/**
 * x402 payment receipts log.
 *
 * Append-only ledger of paid responses, persisted to
 * `userData/x402-receipts.json`. The Payments tab in the wallet
 * sidebar reads it for the "recent payments" view. Schema:
 *
 *   {
 *     id:        unique opaque string (timestamp + counter),
 *     url:       full URL the user navigated to,
 *     origin:    canonicalised (matches the permissions store),
 *     chainId:   number,
 *     asset:     ERC-20 contract address,
 *     amount:    digit string, atomic units,
 *     txHash:    null until/unless the server's PAYMENT-RESPONSE
 *                header carries one,
 *     status:    'settled' (200 + txHash), 'no-receipt' (200 with
 *                no PAYMENT-RESPONSE), or 'failed' (non-2xx),
 *     settledAt: unix seconds,
 *   }
 *
 * Capped at MAX_RECEIPTS entries; older receipts roll off in append
 * order. We don't need crash-tight ACID on this — a lost trailing
 * write costs at most one receipt the user will see again in
 * `freedom://history` and on-chain anyway.
 *
 * Long-term plan ([[project_wallet_history_sqlite]]): unify this and
 * future wallet history into one SQLite store. JSON for v1 keeps WP6
 * focused.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const RECEIPTS_FILE = 'x402-receipts.json';
const MAX_RECEIPTS = 1000;

let cache = null;
let nextSeq = 0;

function receiptsPath() {
  return path.join(app.getPath('userData'), RECEIPTS_FILE);
}

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(receiptsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[x402:receipts] failed to load:', err.message);
    }
    cache = [];
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(receiptsPath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[x402:receipts] failed to save:', err.message);
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Append a receipt. The caller produces every field except `id` (the
 * store stamps a unique sortable ID derived from settledAt + a
 * monotonic counter so receipts written in the same second don't
 * collide). Returns the persisted record.
 *
 * Validation is light — we accept the receipt and persist as long as
 * the type shape is sane. The point of the log is "what the browser
 * actually saw / signed for"; refusing entries because of upstream
 * quirks would silently lose history.
 *
 * @returns {object} The persisted record.
 */
function append({ url, origin, chainId, asset, amount, txHash, status, settledAt }) {
  if (typeof url !== 'string' || typeof origin !== 'string') {
    throw new Error('x402-receipts: url and origin must be strings');
  }
  if (!Number.isFinite(chainId)) {
    throw new Error('x402-receipts: chainId must be a finite number');
  }
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new Error('x402-receipts: amount must be a digit string');
  }

  const all = load();
  const seconds = Number.isFinite(settledAt) ? settledAt : nowSeconds();
  const record = {
    id: `r-${seconds}-${nextSeq++}`,
    url,
    origin,
    chainId,
    asset,
    amount,
    txHash: typeof txHash === 'string' ? txHash : null,
    status: typeof status === 'string' ? status : 'no-receipt',
    settledAt: seconds,
  };
  all.push(record);
  // Cap from the head so we keep the most recent entries. Done here
  // not on read so the file size stays bounded.
  if (all.length > MAX_RECEIPTS) {
    all.splice(0, all.length - MAX_RECEIPTS);
  }
  cache = all;
  save();
  return record;
}

/**
 * Newest-first array of receipts, at most `limit` entries. The
 * Payments-tab UI is the only consumer today; pagination can come
 * later if the volume warrants it.
 */
function getRecent(limit = MAX_RECEIPTS) {
  const all = load();
  const start = Math.max(0, all.length - limit);
  // Slice from the end + reverse — Array.prototype.toReversed isn't
  // available in the renderer's Electron-bundled V8 reliably; slice
  // + reverse is universal.
  return all.slice(start).reverse();
}

function clearAll() {
  cache = [];
  save();
}

function _resetCache() {
  cache = null;
  nextSeq = 0;
}

module.exports = {
  append,
  getRecent,
  clearAll,
  _resetCache,
  MAX_RECEIPTS,
};
