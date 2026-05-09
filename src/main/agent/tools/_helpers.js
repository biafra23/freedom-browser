/**
 * Shared helpers for Pi tool definitions.
 *
 * Three small utilities that every tool file ends up wanting:
 *   - resolveWebContents — looks up an Electron webContents by id with
 *     null + isDestroyed checks; throws a clear error otherwise.
 *   - textBlock — wraps a string in Pi's text-content shape.
 *   - jsonResult — wraps a `details` object into a tool-result with
 *     a JSON.stringified text block (model-readable) plus the raw
 *     details (renderer-readable).
 *
 * Kept underscore-prefixed because it's intra-`tools/` infra, not a
 * Pi-shaped tool file.
 */

const { webContents } = require('electron');

function resolveWebContents(id, label = 'webContents') {
  if (typeof id !== 'number') {
    throw new Error(`no ${label} — id not bound to this tool`);
  }
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) {
    throw new Error(`${label} ${id} is not available`);
  }
  return wc;
}

function textBlock(text) {
  return { type: 'text', text };
}

function jsonResult(details) {
  return {
    content: [textBlock(JSON.stringify(details, null, 2))],
    details,
  };
}

module.exports = { resolveWebContents, textBlock, jsonResult };
