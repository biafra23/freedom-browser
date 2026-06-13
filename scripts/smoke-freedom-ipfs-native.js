#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FreedomIpfsNativeNode } = require('../src/main/ipfs/freedom-ipfs-native-node');

const DEFAULT_LIVE_PATH = '/ipns/ipfs.tech/';
const DEFAULT_LIVE_EXPECT = 'ipfs';
const DEFAULT_LIVE_ATTEMPTS = 3;
const LIVE_TIMEOUT_MS = 45_000;

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

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTitle(body) {
  const match = body.match(/<title[^>]*>(.*?)<\/title>/is);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

async function loadLivePage(node) {
  if (process.env.FREEDOM_IPFS_NATIVE_SMOKE_LIVE === '0') return null;

  const smokePath = process.env.FREEDOM_IPFS_NATIVE_SMOKE_PATH || DEFAULT_LIVE_PATH;
  const expectedText = process.env.FREEDOM_IPFS_NATIVE_SMOKE_EXPECT || DEFAULT_LIVE_EXPECT;
  const attempts = parsePositiveInt(
    process.env.FREEDOM_IPFS_NATIVE_SMOKE_ATTEMPTS,
    DEFAULT_LIVE_ATTEMPTS
  );

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);

    try {
      const response = await node.request({
        method: 'GET',
        path: smokePath,
        headers: new Headers({
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }),
        signal: controller.signal,
      });
      const body = await response.text();
      const title = extractTitle(body);

      assert(
        response.status >= 200 && response.status < 400,
        `live page returned HTTP ${response.status}`
      );
      assert(body.length > 0, 'live page body is empty');
      if (expectedText) {
        assert(
          body.toLowerCase().includes(expectedText.toLowerCase()),
          `live page did not contain expected text: ${expectedText}`
        );
      }

      return {
        path: smokePath,
        status: response.status,
        bytes: body.length,
        title,
        ms: Date.now() - startedAt,
        attempt,
      };
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const delayMs = 1000 * attempt;
        console.warn(
          `[freedom-ipfs-native-smoke] live page attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`
        );
        await sleep(delayMs);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
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
    const buildInfo = parseJson('native build info', node.buildInfoJson());

    started = node.start();
    assert(started, 'native node failed to start');
    assert(node.isHealthy(), 'native node did not become healthy after start');

    const progress = parseJson('progress snapshot', node.progressSnapshotJson());
    const stats = parseJson('native gateway stats', node.nativeGatewayStatsJson());
    const livePage = await loadLivePage(node);

    assert(progress && Array.isArray(progress.active), 'progress snapshot missing active list');
    assert(stats && typeof stats === 'object' && !Array.isArray(stats), 'stats must be an object');

    console.log(
      JSON.stringify(
        {
          target: actualTarget,
          version,
          buildInfo,
          dataDir,
          livePage,
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
