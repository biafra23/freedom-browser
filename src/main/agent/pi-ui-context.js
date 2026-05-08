/**
 * Pi ExtensionUIContext (stub for Phase 1)
 *
 * Pi's extension hooks call `ctx.ui.*` to surface dialogs, notifications,
 * and TUI affordances. The interface is large (~30 methods, mostly TUI-
 * shaped: themes, footers, custom widgets, autocomplete providers). For
 * Freedom embedded in Electron we only need a handful — `confirm`, `select`,
 * `input`, `notify`, `setStatus` — and even those go through renderer IPC.
 *
 * Phase 1 ships a no-op/log-only implementation. Phase 2 wires `confirm`
 * (and probably `notify`/`setStatus`) to renderer IPC channels so the
 * permission-broker hook can `await ctx.ui.confirm(...)` and resolve when
 * the user answers in the chat sidebar.
 *
 * Methods are not declared on a TypeScript interface here — Pi expects
 * duck typing. Methods we don't implement throw on call so we notice rather
 * than silently miss something Pi started using.
 */

const log = require('../logger');

// `ipcBridge` is reserved for Phase 2, where the dialog stubs below close
// over it to forward `confirm`/`select`/`input` to the renderer. Phase 1
// intentionally ignores it — accepting the parameter now keeps the call
// sites stable across phases.
function createPiUIContext(_options = {}) {
  function notWiredAsync(methodName, defaultReturn) {
    return async (...args) => {
      log.warn(`[Pi UI] ${methodName}() — not yet wired; returning default`, args);
      return defaultReturn;
    };
  }

  function logOnly(name, defaultReturn) {
    return (...args) => {
      log.info(`[Pi UI] ${name}() called`, args);
      return defaultReturn;
    };
  }

  return {
    // Dialogs — Phase 2 wires these via ipcBridge to the renderer
    select: notWiredAsync('select', undefined),
    confirm: notWiredAsync('confirm', false),
    input: notWiredAsync('input', undefined),
    editor: notWiredAsync('editor', undefined),

    // Notification surfaces — log-only for Phase 1
    notify: logOnly('notify'),
    setStatus: logOnly('setStatus'),
    setTitle: logOnly('setTitle'),
    setWorkingMessage: logOnly('setWorkingMessage'),
    setWorkingVisible: logOnly('setWorkingVisible'),
    setWorkingIndicator: logOnly('setWorkingIndicator'),
    setHiddenThinkingLabel: logOnly('setHiddenThinkingLabel'),

    // TUI affordances — no-ops in embedded mode
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    onTerminalInput: () => () => {},
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},

    // Theme — return a minimal stand-in so Pi internals that read it don't crash
    theme: { name: 'freedom-noop' },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'themes are not supported in embedded mode' }),

    // Custom overlays — Phase 1 does not support them
    custom: (...args) => {
      log.warn('[Pi UI] custom() not implemented in Phase 1 stub', args);
      throw new Error('Pi UI method "custom" is not implemented in this build');
    },
  };
}

module.exports = { createPiUIContext };
