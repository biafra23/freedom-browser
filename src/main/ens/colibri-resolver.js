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

let cachedClient = null;
let cachedClientKey = null;
let cachedProvider = null;
let inFlightBuild = null;

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

// Lazy singleton. Cache key is the tuple of settings that materially
// affect proof state (prover URL + zk_proof flag); a runtime change to
// either tears down the cached instance and rebuilds. WASM init is paid
// on first use, not module load. `inFlightBuild` collapses concurrent
// first-call lookups onto a single construction — without it, two cold
// requests would both pass the cache check and double-init the WASM.
async function getClient() {
  const [proverUrl] = registry.getEndpoints(CHAIN_ID, 'prover');
  if (!proverUrl) {
    throw new Error(`No Colibri prover configured for chain ${CHAIN_ID}`);
  }
  const zkProof = registry.getNetwork(CHAIN_ID).zkProof !== false;
  const key = `${proverUrl}|${zkProof}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  if (inFlightBuild && inFlightBuild.key === key) return inFlightBuild.promise;

  const promise = (async () => {
    // Storage adapter is registered exactly once per process: on the very
    // first construction. Later settings-change rebuilds reuse it — the
    // adapter is keyless and the Colibri runtime expects a single global.
    if (!cachedClient) {
      await Colibri.register_storage(createDiskStorage());
    }
    const client = new Colibri({
      chainId: CHAIN_ID,
      prover: [proverUrl],
      zk_proof: zkProof,
      privacy_mode: PRIVACY_MODE,
      proofStrategy: Strategy.VerifiedOnly,
    });
    cachedClient = client;
    cachedClientKey = key;
    cachedProvider = new ethers.BrowserProvider(client);
    log.info(`[ens-colibri] client ready (prover=${hostOf(proverUrl)}, zk=${zkProof})`);
    return client;
  })();
  inFlightBuild = { key, promise };
  try { return await promise; }
  finally { if (inFlightBuild && inFlightBuild.promise === promise) inFlightBuild = null; }
}

// Drop-in for what a single `consensusResolve` leg does today, but the
// answer is cryptographically verified by Colibri rather than corroborated
// across multiple public RPCs. No blockTag override — Colibri's verifier
// pins to head − 1 by construction (sync committee signatures for block N
// live in block N+1).
async function resolveViaColibri(name, callData) {
  await getClient();
  return universalResolverCall(cachedProvider, name, callData);
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
  cachedClient = null;
  cachedClientKey = null;
  cachedProvider = null;
  inFlightBuild = null;
}

module.exports = {
  resolveViaColibri,
  resolveReverseViaColibri,
  clearColibriClientForTest,
};
