/**
 * Tiny promise utilities used by the agent layer.
 *
 * Today: a single `raceWithTimeout(promise, ms, message)` helper that
 * lets long-running async work be bounded with a clear error message.
 * Used by:
 *   - pi-extension's tool_call hook to bound async getConsentSignDetails
 *     formatters (so a hung RPC inside a builder can't pin the consent
 *     prompt indefinitely).
 *   - wallet_wait_for_transaction to layer a configurable timeout on
 *     top of ethers' internal 60s wait window.
 *
 * Caveat (and the reason this is a separate helper, not inline): the
 * losing promise is *not* cancelled when the timer wins — only the
 * winner's value/rejection propagates. Callers whose underlying work
 * holds expensive resources should prefer first-class cancellation
 * (AbortSignal) where the underlying API supports it.
 */

function raceWithTimeout(promise, ms, message) {
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timer));
}

module.exports = { raceWithTimeout };
