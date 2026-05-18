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
  }

  // Endpoint sources: builtin, then user-added (which may override a
  // builtin by id), minus any the user explicitly removed.
  const removed = new Set(userConfig.removedSources || []);
  const merged = { ...builtinSources, ...(userConfig.endpointSources || {}) };
  const userSourceIds = new Set(Object.keys(userConfig.endpointSources || {}));
  const endpointSources = {};
  for (const [id, src] of Object.entries(merged)) {
    if (!removed.has(id)) endpointSources[id] = src;
  }

  cache = { networks, endpointSources, userSourceIds, apiKeys };
  return cache;
}

// Drop the cached merge — call after any settings/secret change.
function invalidate() {
  cache = null;
}

function getNetwork(chainId) {
  return load().networks[String(chainId)] || null;
}

function getAllNetworks() {
  return { ...load().networks };
}

// Endpoint source objects covering (chainId, role), raw — the {API_KEY}
// placeholder is left intact. For settings UIs that list sources.
// User-added sources sort ahead of builtins: an endpoint the user
// explicitly configured is preferred over the shipped pool (and is what
// the `direct` strategy resolves to).
function getEndpointSources(chainId, role) {
  const cid = String(chainId);
  const { endpointSources, userSourceIds } = load();
  const out = [];
  for (const [id, src] of Object.entries(endpointSources)) {
    if (src.role === role && src.coverage && src.coverage[cid]) {
      out.push({ id, ...src });
    }
  }
  out.sort((a, b) => Number(userSourceIds.has(b.id)) - Number(userSourceIds.has(a.id)));
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

module.exports = {
  getNetwork,
  getAllNetworks,
  getEndpoints,
  getEndpointSources,
  getKeyedSources,
  invalidate,
};
