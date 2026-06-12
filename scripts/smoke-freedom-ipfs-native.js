#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FreedomIpfsNativeNode } = require('../src/main/ipfs/freedom-ipfs-native-node');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseJson(label, value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${label} was not valid JSON: ${err.message}`, { cause: err });
  }
}

async function main() {
  const expectedTarget = process.env.FREEDOM_IPFS_NATIVE_SMOKE_TARGET;
  const actualTarget = `${process.platform}-${process.arch}`;

  if (expectedTarget) {
    assert(
      actualTarget === expectedTarget,
      `native smoke target mismatch: expected ${expectedTarget}, got ${actualTarget}`
    );
  }

  assert(FreedomIpfsNativeNode.isAvailable(), 'freedom-ipfs native addon is not available');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfs-native-smoke-'));
  const node = new FreedomIpfsNativeNode({ dataDir });
  let started = false;

  try {
    const version = node.version;
    assert(typeof version === 'string' && version.length > 0, 'native version is empty');

    started = node.start();
    assert(started, 'native node failed to start');
    assert(node.isHealthy(), 'native node did not become healthy after start');

    const progress = parseJson('progress snapshot', node.progressSnapshotJson());
    const stats = parseJson('native gateway stats', node.nativeGatewayStatsJson());

    assert(progress && Array.isArray(progress.active), 'progress snapshot missing active list');
    assert(stats && typeof stats === 'object' && !Array.isArray(stats), 'stats must be an object');

    console.log(
      JSON.stringify(
        {
          target: actualTarget,
          version,
          dataDir,
          statsKeys: Object.keys(stats).sort(),
        },
        null,
        2
      )
    );
  } finally {
    if (started) {
      await node.stop();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[freedom-ipfs-native-smoke] ${err.stack || err.message}`);
  process.exit(1);
});
