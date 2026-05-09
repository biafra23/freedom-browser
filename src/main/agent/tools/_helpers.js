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

// Sentinel field name returned by every renderer-side bridge wrapper when
// the call fails. Single source of truth for both sides of the contract;
// renderer wrappers (e.g. `__agentTabBridge__`, `__agentWalletBridge__`)
// return `{ [BRIDGE_ERROR_KEY]: 'message' }`, the main-side `callBridge`
// helper unwraps and re-throws.
const BRIDGE_ERROR_KEY = '__error';

/**
 * Build the JS snippet for a `webContents.executeJavaScript` bridge call.
 * Every arg is `JSON.stringify`-quoted so a model-emitted string can't
 * escape into JS-land (no possibility of injection from a hostile prompt).
 * Exposed for tests; production code goes through `makeBridgeCaller`.
 */
function buildBridgeCallSnippet(globalName, label, method, args = []) {
  const argList = args.map((a) => JSON.stringify(a)).join(', ');
  return `(function(){
    var bridge = window.${globalName};
    if (!bridge || typeof bridge.${method} !== 'function') {
      return { ${BRIDGE_ERROR_KEY}: '${label} bridge unavailable' };
    }
    try { return bridge.${method}(${argList}); }
    catch (e) { return { ${BRIDGE_ERROR_KEY}: String(e && e.message || e) }; }
  })()`;
}

/**
 * Build a closure-bound bridge caller: `await bridge('method', [args])`.
 * Resolves the host webContents per-call so a renderer disposed mid-tool
 * fails cleanly. The label appears in error messages and in the
 * unavailable-bridge sentinel.
 */
function makeBridgeCaller({ globalName, label, hostId }) {
  return async function callBridge(method, args = []) {
    const wc = resolveWebContents(hostId, `host renderer webContents (${label} bridge)`);
    const result = await wc.executeJavaScript(
      buildBridgeCallSnippet(globalName, label, method, args)
    );
    if (result && typeof result === 'object' && BRIDGE_ERROR_KEY in result) {
      throw new Error(`${label} bridge: ${result[BRIDGE_ERROR_KEY]}`);
    }
    return result;
  };
}

module.exports = {
  resolveWebContents,
  textBlock,
  jsonResult,
  buildBridgeCallSnippet,
  makeBridgeCaller,
  BRIDGE_ERROR_KEY,
};
