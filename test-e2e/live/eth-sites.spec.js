// Real-network E2E: Swarm + IPFS cold-start → ENS resolution → page render.
//
// Steps:
//   1. Open the Nodes menu, which starts the bee + ipfs peer-info polling
//      loops.
//   2. Wait for both Swarm and IPFS connected-peer counts to climb past
//      PEER_TARGET. The menu MUST stay open for this — closing it stops
//      the polling and resets the counters to 0
//      (src/renderer/lib/bee-ui.js, src/renderer/lib/ipfs-ui.js).
//   3. Close the menu so it doesn't sit over the address bar.
//   4. Navigate to `meinhard.eth` (Swarm-hosted), assert a play-button-
//      shaped element exists in the active <webview>.
//   5. Navigate to `vitalik.eth` (IPFS-hosted blog), assert an <h1>
//      mentioning "Vitalik" exists in the active <webview>.

const {
  test,
  expect,
  HAS_BEE_BINARY,
  BEE_BINARY_PATH,
  HAS_IPFS_BINARY,
  IPFS_BINARY_PATH,
} = require('../live-fixtures');

const PEER_TARGET = 20;
// Cold-start observations: a freshly-spawned Bee in DHT client mode
// usually crosses 20 peers in 30–120 s; IPFS (Kubo) typically does so
// in 10–60 s. 7 min keeps headroom for slow home connections without
// making the test feel infinite.
const PEER_TIMEOUT_MS = 7 * 60_000;
const NAVIGATION_TIMEOUT_MS = 90_000;
const PAGE_RENDER_TIMEOUT_MS = 60_000;

const PLAY_BUTTON_SNIFFER = `
  (() => {
    const sel = [
      'button[aria-label*="play" i]',
      '[role="button"][aria-label*="play" i]',
      'a[aria-label*="play" i]',
      '.play-button',
      '.play',
      'button.play',
      'video',
      'audio',
    ].join(', ');
    if (document.querySelector(sel)) return true;
    const els = document.querySelectorAll('button, a, [role="button"]');
    for (const el of els) {
      if (/\\bplay\\b/i.test(el.textContent || '')) return true;
    }
    return false;
  })()
`;

const VITALIK_H1_SNIFFER = `
  (() => {
    const headings = document.querySelectorAll('h1');
    for (const h of headings) {
      if (/vitalik/i.test(h.textContent || '')) return true;
    }
    return false;
  })()
`;

// Read the textContent of a peer-count <span> and parse it as an int.
// Returns -1 for "--" / non-numeric placeholders so the polling
// comparator never accidentally satisfies `> PEER_TARGET`.
const readPeerCount = async (locator) => {
  const raw = (await locator.textContent()) || '';
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : -1;
};

// Wait for a peer-count <span> to exceed PEER_TARGET. Polling cadence
// is tuned to the renderer's underlying fetch loops (Bee: 500 ms,
// IPFS: 1 s, see bee-ui.js / ipfs-ui.js) — coarser polls would add
// dead air between the count crossing the threshold and Playwright
// noticing.
const waitForPeers = (locator, label) =>
  expect
    .poll(() => readPeerCount(locator), {
      message: `Waiting for ${label} connected peers > ${PEER_TARGET}`,
      timeout: PEER_TIMEOUT_MS,
      intervals: [500],
    })
    .toBeGreaterThan(PEER_TARGET);

// Drive the address bar the way a user would: focus, fill, Enter.
// Returns once the address bar has normalised to `<scheme>://<ensName>`,
// optionally with a trailing slash or path. The scheme assertion is
// strict: it pins the expected transport (bzz vs ipfs vs ipns) so a
// regression in ENS contenthash dispatch can't silently land us on the
// wrong gateway.
const navigateTo = async (window, ensName, expectedScheme) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(ensName);
  await input.press('Enter');

  const escapedHost = ensName.replace(/\./g, '\\.');
  await expect(input).toHaveValue(
    new RegExp(`^${expectedScheme}://${escapedHost}(/.*)?$`),
    { timeout: NAVIGATION_TIMEOUT_MS }
  );
};

// Playwright's Electron API doesn't expose <webview> guests as Pages,
// so we route through the host renderer and use webview.executeJavaScript()
// — the same DevTools-Protocol primitive Electron exposes for guests.
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
      intervals: [1_000, 2_000, 5_000],
    })
    .toBeTruthy();

test('cold-start: Bee + IPFS reach >20 peers, meinhard.eth & vitalik.eth render', async ({
  window,
}) => {
  test.skip(
    !HAS_BEE_BINARY,
    `Live E2E needs the Bee binary at ${BEE_BINARY_PATH}. Run \`npm run bee:download\` to fetch it.`
  );
  // IPFS is required (not skipped) per test design — failing here gives
  // a much clearer signal than timing out on "Connected Peers" never
  // updating below.
  expect(
    HAS_IPFS_BINARY,
    `Live E2E requires the IPFS binary at ${IPFS_BINARY_PATH}. Run \`npm run ipfs:download\` to fetch it.`
  ).toBe(true);

  const beeMenuButton = window.locator('#bee-menu-button');
  const beeDropdown = window.locator('#bee-menu-dropdown');
  const beePeersCount = window.locator('#bee-peers-count');
  const ipfsPeersCount = window.locator('#ipfs-peers-count');

  // (1) Open the Nodes menu — kicks off bee/ipfs/radicle status
  // polling in the renderer. Both peer counters live inside this
  // single dropdown so we only need one open/close cycle.
  await beeMenuButton.click();
  await expect(beeDropdown).toHaveClass(/open/);

  // (2) Wait for both networks to come up. Run sequentially: in
  // practice IPFS gossips faster than Bee, so by the time Bee crosses
  // 20 peers IPFS is usually already there and the second poll
  // returns on its first sample.
  await waitForPeers(beePeersCount, 'Swarm');
  await waitForPeers(ipfsPeersCount, 'IPFS');

  // (3) Close the menu before driving the address bar. Polling stops
  // and the visible counters reset to 0 — that's expected.
  await beeMenuButton.click();
  await expect(beeDropdown).not.toHaveClass(/open/);

  // (4) meinhard.eth — Swarm-hosted; address bar must end up on bzz://.
  await navigateTo(window, 'meinhard.eth', 'bzz');
  await waitForWebviewCondition(
    window,
    PLAY_BUTTON_SNIFFER,
    'Waiting for a play-button-shaped element on meinhard.eth'
  );

  // (5) vitalik.eth — IPFS-hosted blog; address bar must end up on
  // ipfs://. The page is content-heavy so the H1 is a stable
  // structural marker that the page actually rendered (vs an error
  // page).
  await navigateTo(window, 'vitalik.eth', 'ipfs');
  await waitForWebviewCondition(
    window,
    VITALIK_H1_SNIFFER,
    'Waiting for an <h1> mentioning "Vitalik" on vitalik.eth'
  );
});
