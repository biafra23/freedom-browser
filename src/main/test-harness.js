/**
 * Renderer E2E test harness (Playwright integration)
 *
 * Activated only when `process.env.FREEDOM_TEST_MODE === '1'`. The harness
 * is fully inert otherwise — `installTestHarness` is a no-op when test
 * mode is off, and nothing in this file runs at require time.
 *
 * Responsibilities:
 *   1. Register stub `bzz:` / `ipfs:` / `ipns:` protocol handlers backed by
 *      an in-memory fixture map, so tests can assert against deterministic
 *      content without spinning up Bee or Kubo.
 *   2. Override the ENS resolver IPC handlers with a fixture-driven stub
 *      (real ENS resolution would need network and an Ethereum RPC).
 *   3. Override the Swarm content-probe IPCs so navigation gating doesn't
 *      try to HEAD-poll a non-existent Bee gateway.
 *   4. Override Bee / IPFS / Radicle start/stop IPCs to no-ops, so a
 *      misclick in a test doesn't spawn the real binaries against a temp
 *      `userData` directory.
 *   5. Seed `service-registry` with a "running" status for Bee and IPFS so
 *      the chrome doesn't spend the test session in a "Stopped" UI state.
 *   6. Register `test:*` IPC channels and a `globalThis.__FREEDOM_TEST_HARNESS__`
 *      shim so the Playwright runner can drive fixtures via either
 *      `electronApp.evaluate(...)` or `page.evaluate(... ipcRenderer ...)`.
 *
 * Architectural placement: this lives in `src/main/` because every
 * function it touches (protocol handlers, IPC handlers, service registry)
 * is main-process state. A `src/main/testing/` subdirectory would be
 * justified once the harness grows additional helpers; for now a single
 * file matches the conventions in `src/main/`.
 */

'use strict';

const log = require('./logger');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');
const { success, failure } = require('./ipc-contract');
const { updateService, MODE, setStatusMessage } = require('./service-registry');

const TEST_MODE_ENABLED = process.env.FREEDOM_TEST_MODE === '1';

function isTestMode() {
  return TEST_MODE_ENABLED;
}

// In-memory fixtures. Maps are keyed lower-case for ENS / hashes; content
// fixtures are keyed by exact URL or URL prefix (longest-match wins).
const contentFixtures = new Map();
const ensFixtures = new Map();
const probeFixtures = new Map();

function resetFixtures() {
  contentFixtures.clear();
  ensFixtures.clear();
  probeFixtures.clear();
}

// Longest-prefix match so a fixture for `bzz://<hash>/` answers for
// every sub-resource fetched while loading that page. Exact match wins
// over prefix match by virtue of the length sort.
function pickContentFixture(url) {
  if (contentFixtures.has(url)) return contentFixtures.get(url);
  let best = null;
  let bestLen = -1;
  for (const [prefix, value] of contentFixtures.entries()) {
    if (url.startsWith(prefix) && prefix.length > bestLen) {
      best = value;
      bestLen = prefix.length;
    }
  }
  return best;
}

function buildResponse(fixture) {
  const status = fixture.status ?? 200;
  const headers = {
    'Content-Type': fixture.contentType ?? 'text/html; charset=utf-8',
  };
  return new Response(fixture.body ?? '', { status, headers });
}

function notFoundResponse(url) {
  const body = JSON.stringify({
    code: 404,
    message: `[test-harness] no fixture for ${url}`,
  });
  return new Response(body, {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function makeProtocolHandler(scheme) {
  return async (request) => {
    const fixture = pickContentFixture(request.url);
    if (!fixture) {
      log.info(`[test-harness] ${scheme}: 404 (no fixture) for ${request.url}`);
      return notFoundResponse(request.url);
    }
    return buildResponse(fixture);
  };
}

function makeHttpStubHandler(scheme) {
  return async (request) => {
    log.info(`[test-harness] stubbed ${scheme}: ${request.url}`);
    const body =
      `<!doctype html>` +
      `<title>test-harness ${scheme} stub</title>` +
      `<h1>${scheme}:// blocked in test mode</h1>` +
      `<p data-test="harness-http-stub-url">${request.url}</p>`;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
}

function registerStubProtocols(targetSession) {
  if (!targetSession?.protocol?.handle) {
    log.warn('[test-harness] session.protocol.handle unavailable — skipping protocol stubs');
    return;
  }
  // bzz/ipfs/ipns: harness owns these outright (custom standard schemes
  // we register in production too — see src/main/swarm/bzz-protocol.js
  // etc.). Specs drive content via setContentFixture().
  for (const scheme of ['bzz', 'ipfs', 'ipns']) {
    try {
      targetSession.protocol.handle(scheme, makeProtocolHandler(scheme));
      log.info(`[test-harness] registered stub ${scheme}: handler`);
    } catch (err) {
      log.error(`[test-harness] failed to register stub ${scheme}: handler`, err);
    }
  }
  // http/https: harness owns these too while in test mode, so a spec
  // that exercises a path which calls `webview.loadURL('https://...')`
  // (typing `example.com`, an embedded analytics beacon, an ENS RPC
  // fallback, …) doesn't reach the network. Using `protocol.handle`
  // instead of `webRequest.onBeforeRequest` redirects means we own the
  // scheme — the request never enters Chromium's network stack at all,
  // no DNS lookup, no TCP/TLS handshake. Electron 30+ allows
  // overriding built-in standard schemes; previous handlers are
  // replaced. The webview tag in tabs.js doesn't set a `partition`
  // attribute, which per Electron's <webview> docs means it uses the
  // app default session — i.e. this same one we're attaching to.
  for (const scheme of ['http', 'https']) {
    try {
      targetSession.protocol.handle(scheme, makeHttpStubHandler(scheme));
      log.info(`[test-harness] registered stub ${scheme}: handler (owns scheme)`);
    } catch (err) {
      log.error(`[test-harness] failed to register stub ${scheme}: handler`, err);
    }
  }
}

// Replace a previously-registered ipcMain.handle entry. ipcMain.handle
// throws if the channel is already registered, so removal must happen
// before re-registration. Safe to call when the channel was never
// registered (removeHandler is a no-op then).
function replaceHandler(channel, handler) {
  ipcMain.removeHandler?.(channel);
  ipcMain.handle(channel, handler);
}

function overrideEnsIpc() {
  replaceHandler(IPC.ENS_RESOLVE, async (_event, payload = {}) => {
    const name = (payload?.name || '').trim().toLowerCase();
    if (!name) {
      return { type: 'not_found', name: '', reason: 'EMPTY' };
    }
    if (ensFixtures.has(name)) {
      return ensFixtures.get(name);
    }
    return { type: 'not_found', name, reason: 'NO_FIXTURE' };
  });

  replaceHandler(IPC.ENS_RESOLVE_ADDRESS, async (_event, payload = {}) => {
    const name = (payload?.name || '').trim().toLowerCase();
    return { success: false, name, reason: 'TEST_MODE_NOT_IMPLEMENTED' };
  });

  replaceHandler(IPC.ENS_RESOLVE_REVERSE, async (_event, payload = {}) => {
    const address = typeof payload?.address === 'string' ? payload.address.toLowerCase() : null;
    return { success: false, address, reason: 'TEST_MODE_NOT_IMPLEMENTED' };
  });

  replaceHandler(IPC.ENS_INVALIDATE_CONTENT, async () => true);
}

function overrideProbeIpc() {
  const stubProbes = new Map();
  let nextId = 1;

  replaceHandler(IPC.BZZ_START_PROBE, (_event, payload = {}) => {
    const { hash } = payload;
    if (typeof hash !== 'string' || !hash) {
      return failure('INVALID_HASH', 'Missing hash');
    }
    const id = `test-probe-${nextId++}`;
    const outcome = probeFixtures.get(hash) ?? { ok: true };
    stubProbes.set(id, outcome);
    return success({ id });
  });

  replaceHandler(IPC.BZZ_AWAIT_PROBE, (_event, payload = {}) => {
    const { id } = payload;
    if (typeof id !== 'string' || !stubProbes.has(id)) {
      return failure('UNKNOWN_PROBE', 'Unknown probe id', { id });
    }
    const outcome = stubProbes.get(id);
    stubProbes.delete(id);
    return success({ outcome });
  });

  replaceHandler(IPC.BZZ_CANCEL_PROBE, (_event, payload = {}) => {
    const { id } = payload;
    const cancelled = stubProbes.delete(id);
    return success({ cancelled });
  });
}

// Bee / IPFS / Radicle managers are still loaded so their `getStatus`
// handlers respond, but we replace start/stop with no-ops so a stray
// click in a spec can't spawn the real binaries against the test
// `userData` directory. The fake status is also tracked in-memory so
// the corresponding `*_GET_STATUS` handler reports it (otherwise the
// real manager would still reply with "stopped" and the renderer
// would think the toggle silently failed).
//
// Stub responses match the production IPC shape `{ status, error }`
// — the renderer destructures these fields directly
// (`src/renderer/lib/bee-ui.js`, `src/renderer/lib/ipfs-ui.js`).
const stubNodeStatus = { ant: 'running', ipfs: 'running', radicle: 'running' };

function overrideNodeIpc() {
  const setStatus = (service, status) => {
    stubNodeStatus[service] = status;
    return { status, error: null };
  };

  replaceHandler(IPC.ANT_START, async () => {
    log.info('[test-harness] ignored ant:start (test mode)');
    return setStatus('ant', 'running');
  });
  replaceHandler(IPC.ANT_STOP, async () => {
    log.info('[test-harness] ignored ant:stop (test mode)');
    return setStatus('ant', 'stopped');
  });
  replaceHandler(IPC.ANT_GET_STATUS, async () => ({
    status: stubNodeStatus.ant,
    error: null,
  }));

  replaceHandler(IPC.IPFS_START, async () => {
    log.info('[test-harness] ignored ipfs:start (test mode)');
    return setStatus('ipfs', 'running');
  });
  replaceHandler(IPC.IPFS_STOP, async () => {
    log.info('[test-harness] ignored ipfs:stop (test mode)');
    return setStatus('ipfs', 'stopped');
  });
  replaceHandler(IPC.IPFS_GET_STATUS, async () => ({
    status: stubNodeStatus.ipfs,
    error: null,
  }));

  replaceHandler(IPC.RADICLE_START, async () => {
    log.info('[test-harness] ignored radicle:start (test mode)');
    return setStatus('radicle', 'running');
  });
  replaceHandler(IPC.RADICLE_STOP, async () => {
    log.info('[test-harness] ignored radicle:stop (test mode)');
    return setStatus('radicle', 'stopped');
  });
  replaceHandler(IPC.RADICLE_GET_STATUS, async () => ({
    status: stubNodeStatus.radicle,
    error: null,
  }));
}

function seedRegistry() {
  updateService('ant', {
    api: 'http://127.0.0.1:1633',
    gateway: 'http://127.0.0.1:1633',
    mode: MODE.BUNDLED,
  });
  setStatusMessage('ant', 'Test mode (Swarm stub)');
  updateService('ipfs', {
    api: 'http://127.0.0.1:5001',
    gateway: 'http://localhost:8080',
    mode: MODE.BUNDLED,
  });
  setStatusMessage('ipfs', 'Test mode (IPFS stub)');
}

// `test:*` IPC operations the Playwright runner can invoke from the
// renderer (page.evaluate(() => ipcRenderer.invoke('test:...')) won't
// work because contextIsolation hides ipcRenderer — the runner uses
// electronApp.evaluate(...) and calls these via ipcMain.emit instead,
// or the global shim below).
function registerTestOps() {
  replaceHandler('test:ping', () => ({ ok: true, pid: process.pid }));

  replaceHandler('test:reset-fixtures', () => {
    resetFixtures();
    return { ok: true };
  });

  replaceHandler('test:set-content-fixture', (_event, payload = {}) => {
    const { url, status, contentType, body } = payload;
    if (typeof url !== 'string' || !url) {
      return { ok: false, error: 'missing url' };
    }
    contentFixtures.set(url, { status, contentType, body });
    return { ok: true };
  });

  replaceHandler('test:set-ens-fixture', (_event, payload = {}) => {
    const { name, result } = payload;
    if (typeof name !== 'string' || !name) {
      return { ok: false, error: 'missing name' };
    }
    ensFixtures.set(name.trim().toLowerCase(), result);
    return { ok: true };
  });

  replaceHandler('test:set-probe-fixture', (_event, payload = {}) => {
    const { hash, outcome } = payload;
    if (typeof hash !== 'string' || !hash) {
      return { ok: false, error: 'missing hash' };
    }
    probeFixtures.set(hash, outcome ?? { ok: true });
    return { ok: true };
  });

  replaceHandler('test:get-state', () => ({
    content: [...contentFixtures.keys()],
    ens: [...ensFixtures.keys()],
    probes: [...probeFixtures.keys()],
  }));
}

// Expose a synchronous shim on the main-process global so the Playwright
// runner can drive fixtures via `electronApp.evaluate(() => globalThis
// .__FREEDOM_TEST_HARNESS__.setContentFixture(...))` without an IPC
// round-trip.
function exposeGlobalShim() {
  globalThis.__FREEDOM_TEST_HARNESS__ = {
    setContentFixture: (url, fixture) => {
      contentFixtures.set(url, fixture || {});
    },
    clearContentFixtures: () => contentFixtures.clear(),
    setEnsFixture: (name, result) => {
      ensFixtures.set(String(name).trim().toLowerCase(), result);
    },
    setProbeFixture: (hash, outcome) => {
      probeFixtures.set(hash, outcome ?? { ok: true });
    },
    resetFixtures,
    state: () => ({
      content: [...contentFixtures.keys()],
      ens: [...ensFixtures.keys()],
      probes: [...probeFixtures.keys()],
    }),
  };
}

function installTestHarness({ defaultSession }) {
  if (!TEST_MODE_ENABLED) return false;
  log.info('[test-harness] FREEDOM_TEST_MODE=1 — installing harness');
  resetFixtures();
  registerStubProtocols(defaultSession);
  overrideEnsIpc();
  overrideProbeIpc();
  overrideNodeIpc();
  registerTestOps();
  seedRegistry();
  exposeGlobalShim();
  return true;
}

module.exports = {
  isTestMode,
  installTestHarness,
};
