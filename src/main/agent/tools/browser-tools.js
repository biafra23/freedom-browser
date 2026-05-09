/**
 * Browser Tools (Pi-shaped)
 *
 * First-party tools that read and drive the user's currently active
 * browser tab via Electron's `webContents` API. The tier on each tool
 * tells the broker how much consent is needed:
 *
 *   read_current_tab    local_sensitive    page text — may contain PII
 *   screenshot          local_sensitive    raster of visible content
 *   navigate            browser_mutation   URL change
 *   click               browser_mutation   DOM action
 *   fill                browser_mutation   DOM action
 *
 * The active-tab `webContentsId` is closure-captured at tool-creation
 * time (one tool set per Pi session); the model never sees or chooses
 * it. All `executeJavaScript` payloads pass user-controlled selectors
 * and values through `JSON.stringify` so a model-emitted string can
 * never escape into JS-land.
 *
 * Returned shape matches Pi's `AgentToolResult`: a `content` array of
 * TextContent / ImageContent blocks (what the model sees) plus a free-
 * form `details` object that flows through `tool_result` events to the
 * renderer.
 */

const { webContents } = require('electron');
const { TIERS } = require('../tool-tiers');

// ~Gemma 8k-token context proxy at ~4 chars/token. The slice happens
// page-side so a multi-MB innerText doesn't cross the IPC boundary;
// the post-await `slice` below is a defence-in-depth no-op.
const READ_TEXT_LIMIT = 32_000;

// Static name → tier map. Source of truth for both `createBrowserTools`
// (used at registration) and `getBrowserToolMeta` (used by the broker
// to compute profile-visible tool names without instantiating the
// closures that bind a webContentsId).
const TOOL_TIER_BY_NAME = Object.freeze({
  read_current_tab: TIERS.LOCAL_SENSITIVE,
  screenshot: TIERS.LOCAL_SENSITIVE,
  navigate: TIERS.BROWSER_MUTATION,
  click: TIERS.BROWSER_MUTATION,
  fill: TIERS.BROWSER_MUTATION,
});

const BROWSER_TOOL_META = Object.freeze(
  Object.entries(TOOL_TIER_BY_NAME).map(([name, tier]) => Object.freeze({ name, tier }))
);
function getBrowserToolMeta() {
  return BROWSER_TOOL_META;
}

function getActiveWebContents(webContentsId) {
  if (typeof webContentsId !== 'number') {
    throw new Error('no active tab — webContentsId not bound to this tool');
  }
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    throw new Error(`active tab webContents ${webContentsId} is not available`);
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

/**
 * Build the five Pi-shaped browser tool definitions, closure-bound to
 * a specific webContentsId. Pi's execute signature is
 * `(toolCallId, params, signal, onUpdate, ctx)`; we ignore everything
 * but `params`. The `tier` field is non-standard — pi-extension reads
 * it before calling `pi.registerTool` and uses it both for the broker
 * decision and for `executionMode` (sequential for browser_mutation).
 *
 * `Type` is passed in (rather than imported) because typebox is ESM and
 * this module is required by tests that may want to inject a stub.
 *
 * @param {object} args
 * @param {number|null} args.webContentsId
 * @param {object} args.Type   typebox `Type` import
 */
function createBrowserTools({ webContentsId, Type }) {
  const readCurrentTab = {
    name: 'read_current_tab',
    label: 'Read current tab',
    description:
      "Read the visible text of the user's currently active browser tab. " +
      'Returns up to 32k characters of plain text, no markup.',
    tier: TOOL_TIER_BY_NAME.read_current_tab,
    promptSnippet:
      "fetch the visible text of the user's current browser tab",
    promptGuidelines: [
      'When the user asks about, summarises, quotes, or references the current page, call read_current_tab first.',
      'Do not infer page content from the URL or a screenshot alone — read the text.',
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const wc = getActiveWebContents(webContentsId);
      const text = await wc.executeJavaScript(
        `(((document.body && document.body.innerText) || "")).slice(0, ${READ_TEXT_LIMIT})`
      );
      return jsonResult({
        url: wc.getURL(),
        title: wc.getTitle(),
        text: String(text || '').slice(0, READ_TEXT_LIMIT),
      });
    },
  };

  const navigate = {
    name: 'navigate',
    label: 'Navigate',
    description:
      'Load a URL into the active browser tab. Accepts http/https/bzz/ipfs/ipns/rad and ENS-style hosts.',
    tier: TOOL_TIER_BY_NAME.navigate,
    promptSnippet: 'load a URL in the active tab',
    promptGuidelines: [
      'After navigating, the page text is available via read_current_tab — call it before answering questions about the new page.',
    ],
    parameters: Type.Object({
      url: Type.String({
        minLength: 1,
        // TypeBox's `pattern` is a regex string; the trailing :// match enforces
        // a real URL form. Per-scheme validation is below in execute.
        pattern: '^(https?|bzz|ipfs|ipns|rad|ens)://',
      }),
    }),
    async execute(_toolCallId, { url }) {
      if (!/^(https?|bzz|ipfs|ipns|rad|ens):\/\//i.test(url)) {
        throw new Error(
          'url must use a supported scheme (http, https, bzz, ipfs, ipns, rad, ens)'
        );
      }
      const wc = getActiveWebContents(webContentsId);
      await wc.loadURL(url);
      return jsonResult({ url: wc.getURL() });
    },
  };

  const click = {
    name: 'click',
    label: 'Click',
    description:
      'Click the first element matching the given CSS selector in the active tab. ' +
      'Returns whether an element was found and clicked.',
    tier: TOOL_TIER_BY_NAME.click,
    promptSnippet: 'click an element in the active tab by CSS selector',
    promptGuidelines: [
      'If you do not know the page structure, call read_current_tab first to find a stable selector.',
    ],
    parameters: Type.Object({
      selector: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    async execute(_toolCallId, { selector }) {
      const wc = getActiveWebContents(webContentsId);
      const code = `(function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()`;
      const clicked = await wc.executeJavaScript(code);
      return jsonResult({ clicked: !!clicked });
    },
  };

  const fill = {
    name: 'fill',
    label: 'Fill',
    description:
      'Set the value of the first form input matching the given CSS selector and dispatch input/change events.',
    tier: TOOL_TIER_BY_NAME.fill,
    promptSnippet: 'set the value of a form input in the active tab',
    promptGuidelines: [
      'After filling a form, you usually need to click a submit button or another control.',
    ],
    parameters: Type.Object({
      selector: Type.String({ minLength: 1, maxLength: 500 }),
      value: Type.String({ maxLength: 10_000 }),
    }),
    async execute(_toolCallId, { selector, value }) {
      const wc = getActiveWebContents(webContentsId);
      const code = `(function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`;
      const filled = await wc.executeJavaScript(code);
      return jsonResult({ filled: !!filled });
    },
  };

  const screenshot = {
    name: 'screenshot',
    label: 'Screenshot',
    description:
      'Capture the visible portion of the active tab as a JPEG image the model can see.',
    tier: TOOL_TIER_BY_NAME.screenshot,
    promptSnippet: 'capture an image of the active tab so you can see it',
    promptGuidelines: [
      'Use screenshot when the user wants visual context (layout, images, what something looks like). For text content, use read_current_tab.',
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const wc = getActiveWebContents(webContentsId);
      const image = await wc.capturePage();
      // JPEG q80 instead of PNG: ~5-10x smaller than PNG, ~3-5x faster
      // encode on the main thread. Lossy is fine for "agent looks at the
      // page".
      const base64 = image.toJPEG(80).toString('base64');
      return {
        content: [
          { type: 'image', data: base64, mimeType: 'image/jpeg' },
          textBlock(`Screenshot of ${wc.getURL()}`),
        ],
        details: {
          mimeType: 'image/jpeg',
          dataUrl: `data:image/jpeg;base64,${base64}`,
          url: wc.getURL(),
        },
      };
    },
  };

  return [readCurrentTab, navigate, click, fill, screenshot];
}

module.exports = { createBrowserTools, getBrowserToolMeta };
