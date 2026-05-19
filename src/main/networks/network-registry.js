const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('../logger');
const { migrateLegacyConfig } = require('./migration');

// The unified source of chain + endpoint configuration. Three layers:
//   - builtin    — ships in src/shared/ (chains.json, endpoint-sources.json)
//   - user       — per-app customization (custom-chains.json, network-config.json)
//   - secrets    — API keys (rpc-api-keys.json), used to resolve keyed sources
// A network owns policy (verification strategy, quorum params); endpoint
// sources own capability (a role + a chainId->URL coverage map). Features
// name a network + a role and let getEndpoints / getNetwork resolve.

function builtinPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'src', 'shared', name)
    : path.join(__dirname, '..', '..', 'shared', name);
}

function userDataPath(name) {
  return path.join(app.getPath('userData'), name);
}

// An absent file is an expected state — user-layer files don't exist until
// the user customizes something. Only genuine read/parse errors are logged.
function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.error(`[network-registry] failed to read ${filePath}: ${err.message}`);
    }
    return fallback;
  }
}

let cache = null;

// The user-layer config. When network-config.json is absent but a legacy
// settings.json exists, run the one-shot migration and persist the result.
// Idempotent: once network-config.json is on disk, later loads just read it;
// a crash before the write simply re-migrates next time.
function resolveUserConfig(customChains, builtinSources) {
  const configPath = userDataPath('network-config.json');

  // Distinguish "absent" (a migration candidate) from "present but corrupt".
  // A corrupt file must NOT trigger re-migration — re-deriving from the old
  // legacy settings would clobber a post-migration user's new-model
  // customizations. Corrupt → fall back to defaults, leave the file intact.
  let rawConfig;
  try {
    rawConfig = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.error(`[network-registry] cannot read network-config.json: ${err.message}`);
      return {};
    }
    rawConfig = null; // absent
  }
  if (rawConfig !== null) {
    try {
      return JSON.parse(rawConfig);
    } catch (err) {
      log.error(
        `[network-registry] network-config.json is corrupt, using defaults ` +
        `(file left intact for recovery): ${err.message}`
      );
      return {};
    }
  }

  const legacySettings = readJson(userDataPath('settings.json'), null);
  if (!legacySettings) return {}; // fresh install — nothing to migrate

  const migrated = migrateLegacyConfig({
    settings: legacySettings,
    customChains,
    builtinSources,
  });
  try {
    fs.writeFileSync(configPath, JSON.stringify(migrated, null, 2), 'utf-8');
    log.info('[network-registry] migrated legacy config -> network-config.json');
  } catch (err) {
    log.error(`[network-registry] failed to persist migration: ${err.message}`);
  }
  return migrated; // use it in-memory regardless of write success
}

// Merge the layers into the queryable registry. Cached until invalidate().
function load() {
  if (cache) return cache;

  const builtinNetworks = readJson(builtinPath('chains.json'), {});
  const builtinSources = readJson(builtinPath('endpoint-sources.json'), {});
  const customChains = readJson(userDataPath('custom-chains.json'), {});
  const userConfig = resolveUserConfig(customChains, builtinSources);
  const apiKeys = readJson(userDataPath('rpc-api-keys.json'), {});

  // Networks: builtin chains, then custom chains, then per-network user
  // overrides. verification/quorum are merged one level deep so a partial
  // override (e.g. just quorum.k) doesn't drop the rest of the block.
  // `primary` defaults to 'direct' — custom-chains.json is user-writable
  // and bypasses migration, so a custom chain added without a verification
  // block still resolves to a usable strategy rather than undefined.
  const networks = {};
  for (const [cid, net] of Object.entries({ ...builtinNetworks, ...customChains })) {
    const override = userConfig.networks?.[cid] || {};
    networks[cid] = {
      ...net,
      ...override,
      verification: { primary: 'direct', ...net.verification, ...override.verification },
      quorum: { ...net.quorum, ...override.quorum },
    };
    // rpcUrls (custom chains only) is capability data — it is surfaced as
    // endpoint sources below; the network object itself stays policy-only.
    delete networks[cid].rpcUrls;
  }

  // Endpoint sources: builtin, then user-added (which may override a
  // builtin by id). allSources keeps removed entries — the config view
  // lists them as disabled; endpointSources is the active set queries
  // resolve against (removed entries filtered out).
  const removedSourceIds = new Set(userConfig.removedSources || []);
  const userSourceIds = new Set(Object.keys(userConfig.endpointSources || {}));
  const allSources = { ...builtinSources, ...(userConfig.endpointSources || {}) };
  // A custom chain's catalogue RPCs are stored on its definition. Surface
  // each as a keyless rpc source under a reserved `catalog:` id — not a
  // user-layer id, so it counts as one of the chain's public endpoints
  // rather than a hand-added one.
  for (const [cid, chain] of Object.entries(customChains)) {
    (chain.rpcUrls || []).forEach((url, i) => {
      allSources[`catalog:${cid}:${i + 1}`] = {
        role: 'rpc', keyed: false, coverage: { [cid]: url },
      };
    });
  }
  const endpointSources = {};
  for (const [id, src] of Object.entries(allSources)) {
    if (!removedSourceIds.has(id)) endpointSources[id] = src;
  }

  const customChainIds = new Set(Object.keys(customChains));

  cache = {
    networks, endpointSources, allSources,
    userSourceIds, removedSourceIds, apiKeys, customChainIds,
  };
  return cache;
}

// Drop the cached merge — call after any settings/secret change.
function invalidate() {
  cache = null;
}

// A chain is "custom" when it came from custom-chains.json; every other
// chain is builtin. The flag lets the wallet and settings UI decide what
// a user is allowed to remove.
function withBuiltinFlag(cid, net, customChainIds) {
  return { ...net, builtin: !customChainIds.has(String(cid)) };
}

function getNetwork(chainId) {
  const { networks, customChainIds } = load();
  const net = networks[String(chainId)];
  return net ? withBuiltinFlag(chainId, net, customChainIds) : null;
}

function getAllNetworks() {
  const { networks, customChainIds } = load();
  const out = {};
  for (const [cid, net] of Object.entries(networks)) {
    out[cid] = withBuiltinFlag(cid, net, customChainIds);
  }
  return out;
}

// Whether the registry can resolve at least one rpc endpoint for a chain
// — a keyless builtin RPC, a user-added RPC, or a keyed provider with a
// configured API key. A chain with no usable endpoint can't be used.
function isChainAvailable(chainId) {
  return getEndpoints(chainId, 'rpc').length > 0;
}

function getAvailableChains() {
  const all = getAllNetworks();
  const out = {};
  for (const [cid, net] of Object.entries(all)) {
    if (isChainAvailable(cid)) out[cid] = net;
  }
  return out;
}

// Endpoint source objects covering (chainId, role), raw — the {API_KEY}
// placeholder is left intact. For settings UIs that list sources.
// Sorted by resolution priority in three tiers: a user-added endpoint
// first (you chose it), then a keyed commercial provider (an opt-in,
// higher-reliability endpoint), then a builtin public RPC (the always-on
// fallback). `direct` resolves to the first; quorum / wallet failover
// walk the order.
function getEndpointSources(chainId, role) {
  const cid = String(chainId);
  const { endpointSources, userSourceIds } = load();
  const out = [];
  for (const [id, src] of Object.entries(endpointSources)) {
    if (src.role === role && src.coverage && src.coverage[cid]) {
      out.push({ id, ...src });
    }
  }
  const tierOf = (entry) => {
    if (userSourceIds.has(entry.id)) return 0;
    if (entry.keyed) return 1;
    return 2;
  };
  out.sort((a, b) => tierOf(a) - tierOf(b));
  return out;
}

// Resolved, ready-to-use URLs for (chainId, role). Keyed sources have
// {API_KEY} substituted from the secrets store; a keyed source with no
// enabled key is dropped (it can't produce a usable URL).
function getEndpoints(chainId, role) {
  const cid = String(chainId);
  const { apiKeys } = load();
  const out = [];
  for (const src of getEndpointSources(cid, role)) {
    const url = src.coverage[cid];
    if (!src.keyed) {
      out.push(url);
      continue;
    }
    const entry = apiKeys[src.id];
    if (entry && entry.apiKey && entry.enabled !== false) {
      out.push(url.replace('{API_KEY}', entry.apiKey));
    }
  }
  return out;
}

// Every endpoint source (builtin + user, including removed ones) flattened
// for the settings UI. Each entry is tagged builtin/removed so the config
// view can render disabled builtins and editable user sources.
function getEndpointSourceList() {
  const { allSources, userSourceIds, removedSourceIds } = load();
  return Object.entries(allSources).map(([id, src]) => ({
    id,
    role: src.role,
    keyed: !!src.keyed,
    name: src.name || null,
    coverage: src.coverage || {},
    builtin: !userSourceIds.has(id),
    removed: removedSourceIds.has(id),
  }));
}

// Keyed endpoint sources of a role, as an { id: source } catalog — the
// provider list (Alchemy/Infura/DRPC) the wallet's RPC settings present.
function getKeyedSources(role) {
  const { endpointSources } = load();
  const out = {};
  for (const [id, src] of Object.entries(endpointSources)) {
    if (src.role === role && src.keyed) out[id] = { id, ...src };
  }
  return out;
}

// --- mutation layer ---------------------------------------------------
// Writes go to the user-config layer (network-config.json). Each mutation
// runs load() first so any pending legacy migration has already produced
// network-config.json, then reads that persisted file, edits it, and
// writes it back — invalidating the cache so the next query reflects it.

// The raw user layer. Absent or corrupt → the empty shape, and the
// mutation that follows writes a fresh file. Unlike the load path (which
// preserves a corrupt file for recovery), a deliberate write may replace
// it — a corrupt config was already not in effect.
function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(userDataPath('network-config.json'), 'utf-8'));
  } catch {
    return { networks: {}, endpointSources: {}, removedSources: [] };
  }
}

function writeUserConfig(config) {
  fs.writeFileSync(
    userDataPath('network-config.json'),
    JSON.stringify(config, null, 2),
    'utf-8'
  );
  invalidate();
}

// The custom-chains layer. Unlike network-config.json (per-chain policy
// overrides), custom-chains.json holds full chain definitions for chains
// the user added — load() merges it into the network set.
function readCustomChains() {
  return readJson(userDataPath('custom-chains.json'), {});
}

function writeCustomChains(customChains) {
  fs.writeFileSync(
    userDataPath('custom-chains.json'),
    JSON.stringify(customChains, null, 2),
    'utf-8'
  );
  invalidate();
}

// Merge a partial override into the user layer's networks[chainId].
// verification/quorum merge one level deep against any existing override;
// the rest of each block fills in from the builtin defaults at load time,
// so the persisted override stays minimal (just the user's deviations).
function updateNetwork(chainId, patch) {
  load();
  const config = readUserConfig();
  const networks = { ...(config.networks || {}) };
  const cid = String(chainId);
  const current = networks[cid] || {};
  networks[cid] = { ...current, ...patch };
  if (patch.verification) {
    networks[cid].verification = { ...current.verification, ...patch.verification };
  }
  if (patch.quorum) {
    networks[cid].quorum = { ...current.quorum, ...patch.quorum };
  }
  writeUserConfig({ ...config, networks });
}

// Add or replace a user endpoint source. An explicit re-add also un-hides
// a builtin of the same id (the prior removal no longer applies).
function upsertEndpointSource(id, source) {
  load();
  const config = readUserConfig();
  const endpointSources = { ...(config.endpointSources || {}), [id]: source };
  const removedSources = (config.removedSources || []).filter((x) => x !== id);
  writeUserConfig({ ...config, endpointSources, removedSources });
}

// Remove a source: a user-added one is deleted outright; a builtin is
// added to removedSources (it can't be deleted from endpoint-sources.json).
function removeEndpointSource(id) {
  load();
  const config = readUserConfig();
  const endpointSources = { ...(config.endpointSources || {}) };
  let removedSources = config.removedSources || [];
  if (endpointSources[id]) {
    delete endpointSources[id];
  } else if (!removedSources.includes(id)) {
    removedSources = [...removedSources, id];
  }
  writeUserConfig({ ...config, endpointSources, removedSources });
}

// Un-hide a builtin source that was previously removed.
function restoreEndpointSource(id) {
  load();
  const config = readUserConfig();
  const removedSources = (config.removedSources || []).filter((x) => x !== id);
  writeUserConfig({ ...config, removedSources });
}

// Register a user-defined chain. rpcUrls are stored on the definition
// (load() surfaces them as the chain's public endpoints); the rest is
// persisted verbatim, chainId coerced to a number. verification defaults
// to `direct` at load time. Re-adding an existing custom chain replaces
// its definition. A chainId that collides with a builtin chain is
// rejected — builtin chains are customized via updateNetwork.
function addCustomChain(def, rpcUrls = []) {
  const { networks, customChainIds } = load();
  const chainId = Number(def?.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { success: false, error: 'A valid chain ID is required' };
  }
  const cid = String(chainId);
  if (networks[cid] && !customChainIds.has(cid)) {
    return { success: false, error: 'That chain ID is built in already' };
  }
  const customChains = readCustomChains();
  customChains[cid] = { ...def, chainId, rpcUrls: [...rpcUrls] };
  writeCustomChains(customChains);
  return { success: true, chainId: cid };
}

// Remove a user-defined chain. Its catalogue RPCs are part of the
// definition and go with it; this also drops the chain's network
// override and any hand-added endpoint source that covered only this
// chain (a multi-chain source is left intact).
function removeCustomChain(chainId) {
  const { networks, customChainIds } = load();
  const cid = String(chainId);
  if (networks[cid] && !customChainIds.has(cid)) {
    return { success: false, error: 'Cannot remove a built-in chain' };
  }
  const customChains = readCustomChains();
  if (!customChains[cid]) {
    return { success: false, error: 'Custom chain not found' };
  }
  delete customChains[cid];
  writeCustomChains(customChains);

  const config = readUserConfig();
  const networksOverride = { ...(config.networks || {}) };
  delete networksOverride[cid];
  const endpointSources = {};
  for (const [id, src] of Object.entries(config.endpointSources || {})) {
    const covers = Object.keys(src.coverage || {});
    if (covers.length === 1 && covers[0] === cid) continue;
    endpointSources[id] = src;
  }
  // Drop any disabled-state for this chain's catalogue RPCs — a stale
  // `catalog:<cid>:*` entry would otherwise suppress an endpoint if the
  // chain is re-added later.
  const removedSources = (config.removedSources || []).filter(
    (id) => !id.startsWith(`catalog:${cid}:`)
  );
  writeUserConfig({ ...config, networks: networksOverride, endpointSources, removedSources });
  return { success: true };
}

module.exports = {
  getNetwork,
  getAllNetworks,
  isChainAvailable,
  getAvailableChains,
  getEndpoints,
  getEndpointSources,
  getEndpointSourceList,
  getKeyedSources,
  updateNetwork,
  upsertEndpointSource,
  removeEndpointSource,
  restoreEndpointSource,
  addCustomChain,
  removeCustomChain,
  invalidate,
};
