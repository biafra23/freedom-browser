// Real-network E2E: Arti cold-start -> .onion navigation -> page render.
//
// This runs without FREEDOM_TEST_MODE, starts the production Tor manager, and
// verifies Electron's session proxy can load a real onion service through the
// bundled Arti SOCKS proxy.

const { test, expect, HAS_ARTI_BINARY, ARTI_BINARY_PATH } = require('../live-fixtures');

const DEFAULT_ONION_URL =
  'https://www.guardian2zotagl6tmjucg3lrhxdk4dw3lhbqnkvvkywawy3oqfoprid.onion/';
const ONION_URL = process.env.FREEDOM_TOR_E2E_ONION_URL || DEFAULT_ONION_URL;

const TOR_START_TIMEOUT_MS = 180_000;
const ONION_NAVIGATION_TIMEOUT_MS = 180_000;
const PAGE_RENDER_TIMEOUT_MS = 120_000;

const ONION_RENDER_SNIFFER = `
  (() => {
    const text = [document.title, document.body?.innerText || ''].join('\\n');
    return /guardian/i.test(text);
  })()
`;

async function enableTorIntegration(window) {
  const saved = await window.evaluate(async () => {
    const settings = await window.electronAPI.getSettings();
    return window.electronAPI.saveSettings({
      ...settings,
      enableTorIntegration: true,
      startTorAtLaunch: false,
    });
  });
  expect(saved).toBe(true);
}

const evalInActiveWebview = (window, snippet) =>
  window.evaluate(async (s) => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return false;
    try {
      return await wv.executeJavaScript(s);
    } catch {
      return false;
    }
  }, snippet);

const waitForWebviewCondition = (window, snippet, message) =>
  expect
    .poll(() => evalInActiveWebview(window, snippet), {
      message,
      timeout: PAGE_RENDER_TIMEOUT_MS,
      intervals: [2_000, 5_000],
    })
    .toBeTruthy();

test.describe('live Tor onion access', () => {
  test.skip(
    !HAS_ARTI_BINARY,
    `Live Tor E2E needs the Arti binary at ${ARTI_BINARY_PATH}. Run \`npm run tor:download\` to build it.`
  );

  test('cold-start: Arti starts and a real onion service renders', async ({ window }) => {
    await enableTorIntegration(window);

    await window.evaluate(() => window.tor.start());
    await expect
      .poll(async () => (await window.evaluate(() => window.tor.getStatus())).status, {
        message: 'Waiting for Tor manager to start Arti',
        timeout: TOR_START_TIMEOUT_MS,
        intervals: [1000, 2000, 5000],
      })
      .toBe('running');

    const input = window.locator('[data-test="address-input"]');
    await input.click();
    await input.fill(ONION_URL);
    await input.press('Enter');

    await expect(input).toHaveValue(
      new RegExp(`^${ONION_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      {
        timeout: ONION_NAVIGATION_TIMEOUT_MS,
      }
    );

    await waitForWebviewCondition(
      window,
      ONION_RENDER_SNIFFER,
      `Waiting for onion page content from ${ONION_URL}`
    );
  });
});
