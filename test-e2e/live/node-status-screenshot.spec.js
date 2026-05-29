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

// Wait until both networks have connected to more than this many peers
// before capturing, so the screenshot shows a well-connected node.
const PEER_TARGET = 20;
// Fresh per-run data dirs mean peerstores start empty, so gossip bootstraps
// from scratch every time. Bee typically crosses 20 connected peers in
// 30-180s and Kubo faster; 6 min keeps headroom under the 10 min live-test
// timeout without inviting infinite hangs.
const PEER_TIMEOUT_MS = 6 * 60_000;

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

    // Wait for both networks to cross PEER_TARGET connected peers. The menu
    // stays open the whole time so the polling loops keep running.
    const deadline = Date.now() + PEER_TIMEOUT_MS;
    let bee = -1;
    let ipfs = -1;
    while (Date.now() < deadline) {
      [bee, ipfs] = await Promise.all([readCount(beePeers), readCount(ipfsPeers)]);
      if (bee > PEER_TARGET && ipfs > PEER_TARGET) break;
      await window.waitForTimeout(1000);
    }

    // Capture before asserting so the artifact exists even if a network was
    // slow to reach the target.
    const outPath = path.join(
      repoRoot,
      'playwright-screenshots',
      `node-status-${process.platform}.png`
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await window.screenshot({ path: outPath });

    expect(bee, 'Swarm connected peers').toBeGreaterThan(PEER_TARGET);
    expect(ipfs, 'IPFS connected peers').toBeGreaterThan(PEER_TARGET);
  });
});
