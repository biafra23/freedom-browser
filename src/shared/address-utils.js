/**
 * Address-formatting helpers shared between the main process (agent
 * tools, consent payloads) and the renderer (tool-card renderers).
 *
 * Plain JS / no Electron dependencies so both worlds can require it.
 */

/**
 * Truncate an Ethereum-style 0x address to a short visual form
 * (`0x1234…abcd`). Returns the input unchanged if it's not at least
 * 10 characters long, so non-address-shaped strings (ENS names, empty,
 * undefined) pass through harmlessly.
 */
function shortAddress(address) {
  if (typeof address !== 'string' || address.length < 10) return address || '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

module.exports = { shortAddress };
