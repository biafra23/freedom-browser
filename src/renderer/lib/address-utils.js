/**
 * Address-formatting helpers (renderer side).
 *
 * Mirrors src/shared/address-utils.js bit-for-bit. ES modules cannot
 * require() the shared CJS file, so we keep a parallel copy here —
 * same convention used by src/renderer/lib/origin-utils.js. If you
 * change one, change both. Kept tiny on purpose.
 */

export function shortAddress(address) {
  if (typeof address !== 'string' || address.length < 10) return address || '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
