/**
 * Tab Tools (Pi-shaped)
 *
 * Cross-tab management: list, open, close, switch. The agent in main
 * doesn't own tab state — each tab is a renderer webview and the
 * authoritative list lives in the chat-host renderer's `tabs.js`.
 * This module reaches into that renderer via
 * `webContents.executeJavaScript` against the `window.__agentTabBridge__`
 * object the host wires up at boot (see `src/renderer/index.js`).
 *
 * Bound to `hostWebContentsId` at tool-creation, the same way
 * `browser-tools` binds to `webContentsId` (active tab webview).
 * The two ids are different webContents: `hostWebContentsId` is the
 * chat sidebar's host, `webContentsId` is the active tab's page.
 *
 * Tiers:
 *   list_tabs    LOCAL_SENSITIVE   urls + titles are browsing context
 *   open_tab     BROWSER_MUTATION  loads a URL the user didn't ask for
 *   close_tab    BROWSER_MUTATION  destroys a tab
 *   switch_tab   BROWSER_MUTATION  changes user-visible focus
 */

const { TIERS } = require('../tool-tiers');
const { jsonResult, makeBridgeCaller, buildBridgeCallSnippet } = require('./_helpers');

const TAB_BRIDGE_GLOBAL = '__agentTabBridge__';
const TAB_BRIDGE_LABEL = 'tab';

function createTabTools({ hostWebContentsId, Type }) {
  if (typeof hostWebContentsId !== 'number') return [];

  const callBridge = makeBridgeCaller({
    globalName: TAB_BRIDGE_GLOBAL,
    label: TAB_BRIDGE_LABEL,
    hostId: hostWebContentsId,
  });

  const listTabs = {
    name: 'list_tabs',
    label: 'List tabs',
    description: 'List every open browser tab with id, url, title, and isActive flag.',
    tier: TIERS.LOCAL_SENSITIVE,
    promptSnippet: 'list every open tab (id, url, title, active)',
    promptGuidelines: [
      'Use list_tabs before open/close/switch when you need to know what tabs exist or which is active.',
    ],
    parameters: Type.Object({}),
    async execute() {
      const tabs = await callBridge('listTabs');
      return jsonResult({ tabs: Array.isArray(tabs) ? tabs : [] });
    },
  };

  const openTab = {
    name: 'open_tab',
    label: 'Open new tab',
    description:
      'Open a new browser tab and load the given URL. Accepts http/https/bzz/ipfs/ipns/rad/ens schemes; ' +
      'unsupported schemes (file/data/javascript) are silently dropped to about:blank.',
    tier: TIERS.BROWSER_MUTATION,
    promptSnippet: 'open a new browser tab loading a given URL',
    promptGuidelines: [
      'open_tab returns the new tab object; the new tab becomes active automatically.',
    ],
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
    }),
    async execute(_id, { url }) {
      const tab = await callBridge('openTab', [url]);
      return jsonResult({ tab });
    },
  };

  const closeTab = {
    name: 'close_tab',
    label: 'Close tab',
    description: 'Close the tab with the given id. Use list_tabs first to find ids.',
    tier: TIERS.BROWSER_MUTATION,
    promptSnippet: 'close a tab by id',
    promptGuidelines: [
      'Closing a tab destroys it. If only one tab remains, the browser may open a fresh one in its place.',
    ],
    parameters: Type.Object({
      id: Type.Number({ description: 'Tab id from list_tabs.' }),
    }),
    async execute(_id, { id }) {
      const ok = await callBridge('closeTab', [id]);
      return jsonResult({ closed: !!ok, id });
    },
  };

  const switchTab = {
    name: 'switch_tab',
    label: 'Switch tab',
    description: 'Make the tab with the given id active (visible to the user). Use list_tabs first to find ids.',
    tier: TIERS.BROWSER_MUTATION,
    promptSnippet: 'switch the active tab by id',
    promptGuidelines: [
      'After switching, the active tab tools (read_current_tab, navigate, click, fill, screenshot) operate on the newly-active tab.',
    ],
    parameters: Type.Object({
      id: Type.Number({ description: 'Tab id from list_tabs.' }),
    }),
    async execute(_id, { id }) {
      const ok = await callBridge('switchTab', [id]);
      return jsonResult({ switched: !!ok, id });
    },
  };

  return [listTabs, openTab, closeTab, switchTab];
}

// Test seam: lets the existing bridge-script-shape tests call
// `bridgeCall(method, args)` without knowing the global/label binding.
const bridgeCall = (method, args) =>
  buildBridgeCallSnippet(TAB_BRIDGE_GLOBAL, TAB_BRIDGE_LABEL, method, args);

module.exports = { createTabTools, _internals: { bridgeCall } };
