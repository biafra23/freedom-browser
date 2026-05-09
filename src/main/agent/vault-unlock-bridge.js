/**
 * Vault Unlock Bridge (Phase 7d.3)
 *
 * On-demand vault unlock for agent-initiated signing tools. The
 * IDENTITY_OR_SIGNING consent prompt fires first (always-ask tier);
 * once the user clicks Allow, the tool's execute starts. If the vault
 * is already unlocked, the tool just signs. If not, this bridge fires
 * a second prompt — the existing renderer-side `showVaultUnlock` UI
 * (Touch ID / password) — and waits for the user to either unlock or
 * cancel.
 *
 * Two-step prompt deliberately mirrors how dApps handle the same case
 * (consent → optional unlock). A unified card would be more elegant
 * but would special-case the consent UI for one tier; deferred unless
 * the two-step flow proves annoying in practice.
 *
 * Module-level singleton state because vault unlock is global (only
 * one vault per app) and decoupled from per-session toolCallContext —
 * any signing tool from any agent session needs the same prompt.
 *
 * Cancel paths handled:
 *   - User dismisses the unlock screen → renderer sends `cancelled`
 *   - Parent agent abort signal fires → reject + drop pending entry
 *   - Host webContents destroyed before request lands → reject up-front
 */

const crypto = require('node:crypto');
const { webContents } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');

// requestId → { resolve, reject, cleanup }
const pendingRequests = new Map();

/**
 * Ask the renderer to walk the user through unlocking the vault.
 * Resolves when the renderer reports `unlocked`; rejects on cancel,
 * abort, or unreachable host renderer.
 *
 * @param {object} args
 * @param {string} args.reason            Human-readable explanation shown
 *                                        on the unlock screen (e.g. the
 *                                        agent-supplied signing reason).
 * @param {number} args.hostWebContentsId The chat-host renderer id.
 * @param {AbortSignal} [args.signal]     Optional parent abort signal.
 */
async function requestVaultUnlock({ reason, hostWebContentsId, signal }) {
  if (signal?.aborted) {
    throw new Error('Vault unlock aborted before start');
  }
  if (typeof hostWebContentsId !== 'number') {
    throw new Error('Vault unlock requires a host webContents id');
  }
  const wc = webContents.fromId(hostWebContentsId);
  if (!wc || wc.isDestroyed()) {
    throw new Error('Host renderer unavailable for vault unlock');
  }

  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const entry = pendingRequests.get(requestId);
      if (!entry) return;
      entry.cleanup();
      reject(new Error('Vault unlock aborted by parent'));
    };

    const cleanup = () => {
      pendingRequests.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    pendingRequests.set(requestId, {
      resolve: () => {
        cleanup();
        resolve();
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
      cleanup,
    });

    signal?.addEventListener('abort', onAbort, { once: true });

    log.info(`[VaultUnlock] requesting unlock (${requestId.slice(0, 8)}…) reason=${reason}`);
    wc.send(IPC.AGENT_VAULT_UNLOCK_REQUEST, { requestId, reason });
  });
}

/**
 * IPC handler — routed from agent-ipc.js when the renderer reports
 * the unlock outcome. Status is `'unlocked'` or `'cancelled'`.
 */
function handleResult({ requestId, status }) {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    log.warn(`[VaultUnlock] result for unknown requestId ${requestId}`);
    return;
  }
  if (status === 'unlocked') {
    log.info(`[VaultUnlock] unlocked (${requestId.slice(0, 8)}…)`);
    pending.resolve();
  } else {
    log.info(`[VaultUnlock] cancelled (${requestId.slice(0, 8)}…)`);
    pending.reject(new Error('Vault unlock cancelled by user'));
  }
}

module.exports = {
  requestVaultUnlock,
  handleResult,
  _internals: {
    pendingRequests,
    clearAll: () => pendingRequests.clear(),
  },
};
