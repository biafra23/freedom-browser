// Live E2E: start the real Bee + IPFS (Kubo) nodes, let them gossip to a few
// peers, then screenshot the open Nodes menu so the capture shows live node
// status and connected-peer counts.
//
// Opening the Nodes menu is what starts the bee/ipfs status + peer polling
// loops (src/renderer/lib/bee-ui.js, ipfs-ui.js); the menu must stay open
// while we wait and capture, or the counters reset.

const fs = require('fs');
const path = require('path');
const {
  test,
  expect,
  HAS_BEE_BINARY,
  BEE_BINARY_PATH,
  HAS_IPFS_BINARY,
  IPFS_BINARY_PATH,
} = require('../live-fixtures');

const repoRoot = path.resolve(__dirname, '..', '..');

// The ask is "some" peers within ~30s — we don't fail if a network is slow,
// the screenshot of the current status is the deliverable.
const PEER_WAIT_MS = 30_000;

const readCount = async (locator) => {
  const raw = (await locator.textContent()) || '';
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : -1;
};

test.describe('live node-status screenshot', () => {
  test.skip(
    !HAS_BEE_BINARY,
    `Needs the Bee binary at ${BEE_BINARY_PATH} (run \`npm run bee:download\`).`
  );
  test.skip(
    !HAS_IPFS_BINARY,
    `Needs the IPFS binary at ${IPFS_BINARY_PATH} (run \`npm run ipfs:download\`).`
  );

  test('capture Nodes menu with live peer counts', async ({ window }) => {
    const beeMenuButton = window.locator('#bee-menu-button');
    const beeDropdown = window.locator('#bee-menu-dropdown');
    const beePeers = window.locator('#bee-peers-count');
    const ipfsPeers = window.locator('#ipfs-peers-count');

    await beeMenuButton.click();
    await expect(beeDropdown).toHaveClass(/open/);

    // Wait up to ~30s for both networks to connect to some peers.
    const deadline = Date.now() + PEER_WAIT_MS;
    while (Date.now() < deadline) {
      const [bee, ipfs] = await Promise.all([readCount(beePeers), readCount(ipfsPeers)]);
      if (bee > 0 && ipfs > 0) break;
      await window.waitForTimeout(1000);
    }

    const outPath = path.join(
      repoRoot,
      'playwright-screenshots',
      `node-status-${process.platform}.png`
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await window.screenshot({ path: outPath });
  });
});
