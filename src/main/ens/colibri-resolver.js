const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { ethers } = require('ethers');
const Colibri = require('@corpus-core/colibri-stateless').default;
const { Strategy } = require('@corpus-core/colibri-stateless');
const log = require('../logger');
const registry = require('../networks/network-registry');
const { universalResolverCall, universalResolverReverse, hostOf } = require('../ens-resolver');

// privacy_mode 'basic' is a strict improvement (call params never sent
// to the prover); pinning rather than exposing as a toggle keeps the
// threat model legible.
const PRIVACY_MODE = 'basic';
const CHAIN_ID = 1;
const MAX_LATEST_AGE_SECONDS = 60;

let cachedClient = null;
let cachedClientKey = null;
let cachedProvider = null;
let inFlightBuild = null;
let storageRegistration = null;
let storageRegistered = false;
let buildGeneration = 0;

// Disk-backed storage adapter for Colibri's verifier state (sync committee
// pubkeys, current head witness, etc — keys like "states_1" / "sync_1_<slot>").
// The bundled default writes these to process.cwd(), which means launching
// the browser from a different directory loses the warm-cache state and
// scatters files across the filesystem. Redirect to a stable per-app dir.
function createDiskStorage() {
  const dir = path.join(app.getPath('userData'), 'colibri');
  fs.mkdirSync(dir, { recursive: true });
  return {
    get: (key) => {
      try { return fs.readFileSync(path.join(dir, key)); }
      catch { return null; }
    },
    set: (key, value) => { fs.writeFileSync(path.join(dir, key), value); },
    del: (key) => {
      try { fs.unlinkSync(path.join(dir, key)); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
    },
  };
}

async function ensureStorageRegistered() {
  if (storageRegistered) return;
  if (!storageRegistration) {
    storageRegistration = Colibri.register_storage(createDiskStorage())
      .then(() => { storageRegistered = true; })
      .catch((err) => {
        storageRegistration = null;
        throw err;
      });
  }
  await storageRegistration;
}

function destroyClient(client) {
  if (!client || typeof client.destroy !== 'function') return;
  try {
    client.destroy();
  } catch (err) {
    log.warn(`[ens-colibri] failed to destroy old client: ${err.message}`);
  }
}

async function buildClient({ key, proverUrl, zkProof, generation }) {
  // Storage adapter is registered exactly once per process: on the very
  // first construction. Later settings-change rebuilds reuse it — the
  // adapter is keyless and the Colibri runtime expects a single global.
  await ensureStorageRegistered();

  const client = new Colibri({
    chainId: CHAIN_ID,
    prover: [proverUrl],
    zk_proof: zkProof,
    privacy_mode: PRIVACY_MODE,
    proofStrategy: Strategy.VerifiedOnly,
    max_latest_age_seconds: MAX_LATEST_AGE_SECONDS,
  });

  if (generation !== buildGeneration) {
    destroyClient(client);
    return getClient();
  }

  const previousClient = cachedClient;
  cachedClient = client;
  cachedClientKey = key;
  cachedProvider = new ethers.BrowserProvider(client);
  destroyClient(previousClient);
  log.info(`[ens-colibri] client ready (prover=${hostOf(proverUrl)}, zk=${zkProof})`);
  return client;
}

// Lazy singleton. Cache key is the tuple of settings that materially
// affect proof state (prover URL + zk_proof flag); a runtime change to
// either tears down the cached instance and rebuilds. WASM init is paid
// on first use, not module load. `inFlightBuild` collapses concurrent
// first-call lookups onto a single construction. The generation counter
// prevents a slower old-settings build from replacing a newer client.
async function getClient() {
  const [proverUrl] = registry.getEndpoints(CHAIN_ID, 'prover');
  if (!proverUrl) {
    throw new Error(`No Colibri prover configured for chain ${CHAIN_ID}`);
  }
  const zkProof = registry.getNetwork(CHAIN_ID).zkProof !== false;
  const key = `${proverUrl}|${zkProof}`;
  if (cachedClient && cachedClientKey === key) {
    if (inFlightBuild && inFlightBuild.key !== key) buildGeneration += 1;
    return cachedClient;
  }
  if (inFlightBuild && inFlightBuild.key === key) return inFlightBuild.promise;

  const generation = buildGeneration + 1;
  buildGeneration = generation;
  const promise = buildClient({ key, proverUrl, zkProof, generation });
  inFlightBuild = { key, promise, generation };
  try { return await promise; }
  finally { if (inFlightBuild && inFlightBuild.promise === promise) inFlightBuild = null; }
}

// Drop-in for what a single `consensusResolve` leg does today, but the
// answer is cryptographically verified by Colibri rather than corroborated
// across multiple public RPCs. No blockTag override — Colibri's verifier
// pins to head − 1 by construction (sync committee signatures for block N
// live in block N+1).
async function resolveCallViaColibri(name, callData, callResolver = universalResolverCall) {
  await getClient();
  return callResolver(cachedProvider, name, callData);
}

async function resolveViaColibri(name, callData) {
  return resolveCallViaColibri(name, callData, universalResolverCall);
}

// Reverse counterpart: cryptographically-verified `ur.reverse` for an
// address. Returns { name } on a successful (forward-verified) lookup.
// Throws on revert (UR's ResolverNotFound / ReverseAddressMismatch) or
// network/verification failure — the orchestrator classifies.
async function resolveReverseViaColibri(addressBytes) {
  await getClient();
  return universalResolverReverse(cachedProvider, addressBytes);
}

function clearColibriClientForTest() {
  destroyClient(cachedClient);
  cachedClient = null;
  cachedClientKey = null;
  cachedProvider = null;
  inFlightBuild = null;
  storageRegistration = null;
  storageRegistered = false;
  buildGeneration += 1;
}

module.exports = {
  resolveCallViaColibri,
  resolveViaColibri,
  resolveReverseViaColibri,
  clearColibriClientForTest,
};
