/**
 * Network configuration IPC.
 *
 * Bridges the settings UI (the Networks page + the ENS lens) to the
 * network registry: reads the merged config, applies mutations, and
 * manages keyed-provider API keys. After a mutation the downstream
 * provider/ENS caches are dropped so a config change takes effect
 * without a restart.
 */

const { ipcMain } = require('electron');
const registry = require('./network-registry');
const rpcManager = require('../wallet/rpc-manager');

// registry.invalidate() already ran inside the mutation; this also drops
// the caches that sit downstream of the registry — the wallet provider
// pool and the ENS resolver pool — so the change is reflected live.
function refreshDownstream() {
  require('../wallet/provider-manager').clearProviderCache();
  require('../ens-resolver').invalidateCachedProvider();
}

// The full config view: every network plus every endpoint source, with
// keyed providers tagged by whether an API key is configured.
function getConfig() {
  const sources = registry.getEndpointSourceList().map((src) =>
    src.keyed ? { ...src, hasKey: rpcManager.hasApiKey(src.id) } : src
  );
  return { networks: registry.getAllNetworks(), sources };
}

function registerNetworkConfigIpc() {
  ipcMain.handle('networks:get-config', () => {
    return { success: true, ...getConfig() };
  });

  ipcMain.handle('networks:update-network', (_event, chainId, patch) => {
    registry.updateNetwork(chainId, patch);
    refreshDownstream();
    return { success: true };
  });

  ipcMain.handle('networks:upsert-source', (_event, id, source) => {
    registry.upsertEndpointSource(id, source);
    refreshDownstream();
    return { success: true };
  });

  ipcMain.handle('networks:remove-source', (_event, id) => {
    registry.removeEndpointSource(id);
    refreshDownstream();
    return { success: true };
  });

  ipcMain.handle('networks:restore-source', (_event, id) => {
    registry.restoreEndpointSource(id);
    refreshDownstream();
    return { success: true };
  });

  // API keys for keyed providers. setApiKey/removeApiKey already refresh
  // the downstream caches via rpc-manager's onApiKeysChanged hook.
  ipcMain.handle('networks:set-api-key', (_event, providerId, apiKey) => {
    return rpcManager.setApiKey(providerId, apiKey);
  });

  ipcMain.handle('networks:remove-api-key', (_event, providerId) => {
    return rpcManager.removeApiKey(providerId);
  });

  ipcMain.handle('networks:test-api-key', (_event, providerId, apiKey) => {
    return rpcManager.testApiKey(providerId, apiKey);
  });

  console.log('[NetworkConfig] IPC handlers registered');
}

module.exports = { registerNetworkConfigIpc };
