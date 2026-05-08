/**
 * Browser Tools
 *
 * First-party tools that read and drive the user's currently active
 * browser tab via Electron's `webContents` API. The tier on each tool
 * tells the broker how much consent is needed:
 *
 *   read_current_tab    local_sensitive    (page text — may contain PII)
 *   screenshot          local_sensitive    (raster of visible content)
 *   navigate            browser_mutation   (URL change)
 *   click               browser_mutation   (DOM action)
 *   fill                browser_mutation   (DOM action)
 *
 * The `webContentsId` of the active tab is injected into `ctx` by the
 * agent-loop layer (Phase 5a-iii); the model never sees or chooses it.
 *
 * All `executeJavaScript` payloads pass user-controlled selectors /
 * values through `JSON.stringify` so a model-emitted string can never
 * escape into JS-land. The tools refuse if `ctx.webContentsId` is
 * missing or no longer points at a live WebContents.
 */

const { webContents } = require('electron');
const { z } = require('zod');
const { TIERS } = require('../tool-tiers');

// ~Gemma 8k-token context proxy at ~4 chars/token. The slice happens
// page-side so a multi-MB innerText doesn't cross the IPC boundary;
// the post-await `slice` below is a defence-in-depth no-op.
const READ_TEXT_LIMIT = 32_000;

function getActiveWebContents(ctx) {
  if (!ctx || typeof ctx.webContentsId !== 'number') {
    throw new Error('no active tab — webContentsId missing from tool context');
  }
  const wc = webContents.fromId(ctx.webContentsId);
  if (!wc || wc.isDestroyed()) {
    throw new Error(`active tab webContents ${ctx.webContentsId} is not available`);
  }
  return wc;
}

const readCurrentTab = {
  name: 'read_current_tab',
  description:
    "Read the visible text of the user's currently active browser tab. " +
    'Returns up to 32k characters of plain text, no markup.',
  tier: TIERS.LOCAL_SENSITIVE,
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const wc = getActiveWebContents(ctx);
    const text = await wc.executeJavaScript(
      `(((document.body && document.body.innerText) || "")).slice(0, ${READ_TEXT_LIMIT})`
    );
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      text: String(text || '').slice(0, READ_TEXT_LIMIT),
    };
  },
};

const navigate = {
  name: 'navigate',
  description:
    'Load a URL into the active browser tab. Accepts http/https/bzz/ipfs/ipns/rad and ENS-style hosts.',
  tier: TIERS.BROWSER_MUTATION,
  inputSchema: z.object({
    url: z
      .string()
      .min(1)
      .refine(
        (v) => /^(https?|bzz|ipfs|ipns|rad|ens):\/\//i.test(v),
        'url must use a supported scheme (http, https, bzz, ipfs, ipns, rad, ens)'
      ),
  }),
  async execute({ url }, ctx) {
    const wc = getActiveWebContents(ctx);
    await wc.loadURL(url);
    return { url: wc.getURL() };
  },
};

const click = {
  name: 'click',
  description:
    'Click the first element matching the given CSS selector in the active tab. ' +
    'Returns whether an element was found and clicked.',
  tier: TIERS.BROWSER_MUTATION,
  inputSchema: z.object({
    selector: z.string().min(1).max(500),
  }),
  async execute({ selector }, ctx) {
    const wc = getActiveWebContents(ctx);
    const code = `(function () {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`;
    const clicked = await wc.executeJavaScript(code);
    return { clicked: !!clicked };
  },
};

const fill = {
  name: 'fill',
  description:
    'Set the value of the first form input matching the given CSS selector and dispatch input/change events.',
  tier: TIERS.BROWSER_MUTATION,
  inputSchema: z.object({
    selector: z.string().min(1).max(500),
    value: z.string().max(10_000),
  }),
  async execute({ selector, value }, ctx) {
    const wc = getActiveWebContents(ctx);
    const code = `(function () {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    const filled = await wc.executeJavaScript(code);
    return { filled: !!filled };
  },
};

const screenshot = {
  name: 'screenshot',
  description:
    'Capture the visible portion of the active tab as a JPEG (base64-encoded data URL).',
  tier: TIERS.LOCAL_SENSITIVE,
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const wc = getActiveWebContents(ctx);
    const image = await wc.capturePage();
    // JPEG q80 instead of PNG: ~5-10× smaller payload across IPC and to
    // the model's vision pipeline, ~3-5× faster encode on the main
    // thread. Lossy compression is fine for "agent looks at the page".
    return {
      mimeType: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`,
    };
  },
};

const BROWSER_TOOLS = Object.freeze([
  readCurrentTab,
  navigate,
  click,
  fill,
  screenshot,
]);

module.exports = { BROWSER_TOOLS };
