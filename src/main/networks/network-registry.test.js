// Unit tests for the network registry — layer merging and endpoint
// resolution. `node:fs` is mocked: mockFiles maps a basename to its JSON
// string; an absent entry simulates ENOENT (the file-not-present state).
// `electron` resolves to the shared __mocks__/electron.js (isPackaged
// false, a stub getPath) — the fs mock dispatches by basename, so the
// userData directory value is irrelevant here.

const mockFiles = {};
const mockWriteFileSync = jest.fn();
jest.mock('node:fs', () => ({
  readFileSync: (filePath) => {
    const name = require('node:path').basename(filePath);
    if (!(name in mockFiles)) {
      throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
    }
    return mockFiles[name];
  },
  writeFileSync: (...args) => {
    mockWriteFileSync(...args);
    mockFiles[require('node:path').basename(args[0])] = args[1];
  },
}));

const registry = require('./network-registry');

// --- fixtures ---------------------------------------------------------
const CHAINS = {
  '1': {
    chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH',
    verification: { primary: 'colibri' },
    quorum: { k: 3, m: 2, timeoutMs: 5000, anchor: 'latest' },
    zkProof: true,
  },
  '100': {
    chainId: 100, name: 'Gnosis', nativeSymbol: 'xDAI',
    verification: { primary: 'quorum' },
    quorum: { k: 3, m: 2, timeoutMs: 5000, anchor: 'latest' },
  },
};

const SOURCES = {
  'colibri-corpus': { role: 'prover', keyed: false, coverage: { '1': 'https://prover.example' } },
  'eth-public': { role: 'rpc', keyed: false, coverage: { '1': 'https://eth.public.example' } },
  'gno-public': { role: 'rpc', keyed: false, coverage: { '100': 'https://gno.public.example' } },
  'alchemy': {
    role: 'rpc', keyed: true,
    coverage: {
      '1': 'https://eth.alchemy.example/v2/{API_KEY}',
      '100': 'https://gno.alchemy.example/v2/{API_KEY}',
    },
  },
};

function setFiles({ chains = CHAINS, sources = SOURCES, custom, userConfig, apiKeys, settings } = {}) {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  mockFiles['chains.json'] = JSON.stringify(chains);
  mockFiles['endpoint-sources.json'] = JSON.stringify(sources);
  if (custom !== undefined) mockFiles['custom-chains.json'] = JSON.stringify(custom);
  if (userConfig !== undefined) mockFiles['network-config.json'] = JSON.stringify(userConfig);
  if (apiKeys !== undefined) mockFiles['rpc-api-keys.json'] = JSON.stringify(apiKeys);
  if (settings !== undefined) mockFiles['settings.json'] = JSON.stringify(settings);
  mockWriteFileSync.mockClear();
  registry.invalidate();
}

beforeEach(() => setFiles());

describe('getNetwork / getAllNetworks', () => {
  test('returns a builtin network by id', () => {
    expect(registry.getNetwork(1)).toMatchObject({
      name: 'Ethereum',
      verification: { primary: 'colibri' },
      zkProof: true,
    });
  });

  test('accepts numeric or string chain id', () => {
    expect(registry.getNetwork('1')).toEqual(registry.getNetwork(1));
  });

  test('returns null for an unknown chain', () => {
    expect(registry.getNetwork(999)).toBeNull();
  });

  test('getAllNetworks merges builtin + custom chains', () => {
    setFiles({ custom: { '8453': { chainId: 8453, name: 'Base', verification: { primary: 'quorum' } } } });
    expect(Object.keys(registry.getAllNetworks()).sort()).toEqual(['1', '100', '8453']);
    expect(registry.getNetwork(8453).name).toBe('Base');
  });

  test('a custom chain with no verification block defaults to direct', () => {
    // custom-chains.json is user-writable and bypasses migration — getNetwork
    // must still hand back a usable strategy, not verification: {}.
    setFiles({ custom: { '777': { chainId: 777, name: 'CustomNet' } } });
    expect(registry.getNetwork(777).verification.primary).toBe('direct');
  });
});

describe('getEndpoints — resolution', () => {
  test('keyless rpc source returns its URL as-is', () => {
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://eth.public.example');
  });

  test('role filter — prover vs rpc are separate', () => {
    expect(registry.getEndpoints(1, 'prover')).toEqual(['https://prover.example']);
    expect(registry.getEndpoints(1, 'prover')).not.toContain('https://eth.public.example');
  });

  test('coverage filter — a source not covering the chain is excluded', () => {
    // gno-public covers 100 only; must not appear for chain 1.
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('https://gno.public.example');
    expect(registry.getEndpoints(100, 'rpc')).toContain('https://gno.public.example');
  });

  test('keyed source: {API_KEY} substituted when a key is configured', () => {
    setFiles({ apiKeys: { alchemy: { apiKey: 'SECRET', enabled: true } } });
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://eth.alchemy.example/v2/SECRET');
  });

  test('keyed source: dropped when no key is configured', () => {
    // no rpc-api-keys.json → alchemy produces no URL
    expect(registry.getEndpoints(1, 'rpc').some((u) => u.includes('alchemy'))).toBe(false);
  });

  test('keyed source: dropped when the key is explicitly disabled', () => {
    setFiles({ apiKeys: { alchemy: { apiKey: 'SECRET', enabled: false } } });
    expect(registry.getEndpoints(1, 'rpc').some((u) => u.includes('alchemy'))).toBe(false);
  });

  test('keyed source covers multiple chains off one key', () => {
    setFiles({ apiKeys: { alchemy: { apiKey: 'K', enabled: true } } });
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://eth.alchemy.example/v2/K');
    expect(registry.getEndpoints(100, 'rpc')).toContain('https://gno.alchemy.example/v2/K');
  });
});

describe('getEndpointSources', () => {
  test('returns source objects with their id, raw {API_KEY} intact', () => {
    setFiles({ apiKeys: { alchemy: { apiKey: 'SECRET', enabled: true } } });
    const sources = registry.getEndpointSources(1, 'rpc');
    const alchemy = sources.find((s) => s.id === 'alchemy');
    expect(alchemy.coverage['1']).toBe('https://eth.alchemy.example/v2/{API_KEY}');
  });
});

describe('getKeyedSources', () => {
  test('returns only keyed sources of the role, each carrying its id', () => {
    const keyed = registry.getKeyedSources('rpc');
    expect(Object.keys(keyed)).toEqual(['alchemy']);
    expect(keyed.alchemy).toMatchObject({ id: 'alchemy', role: 'rpc', keyed: true });
  });

  test('keyless sources and other roles are excluded', () => {
    const keyed = registry.getKeyedSources('rpc');
    expect(keyed['eth-public']).toBeUndefined();
    expect(keyed['colibri-corpus']).toBeUndefined();
  });
});

describe('user config layer', () => {
  test('per-network verification override is applied', () => {
    setFiles({ userConfig: { networks: { '1': { verification: { primary: 'quorum' } } } } });
    expect(registry.getNetwork(1).verification.primary).toBe('quorum');
  });

  test('partial quorum override merges, keeps the rest of the block', () => {
    setFiles({ userConfig: { networks: { '1': { quorum: { k: 5 } } } } });
    expect(registry.getNetwork(1).quorum).toMatchObject({ k: 5, m: 2, timeoutMs: 5000 });
  });

  test('removedSources excludes a builtin source', () => {
    setFiles({ userConfig: { removedSources: ['eth-public'] } });
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('https://eth.public.example');
  });

  test('user-added endpoint source is included', () => {
    setFiles({
      userConfig: {
        endpointSources: {
          'user-local': { role: 'rpc', keyed: false, coverage: { '1': 'http://localhost:8545' } },
        },
      },
    });
    expect(registry.getEndpoints(1, 'rpc')).toContain('http://localhost:8545');
  });

  test('a user-added source sorts ahead of builtin sources', () => {
    setFiles({
      userConfig: {
        endpointSources: {
          'user-local': { role: 'rpc', keyed: false, coverage: { '1': 'http://localhost:8545' } },
        },
      },
    });
    // The `direct` strategy resolves to getEndpoints(...)[0] — the user's
    // own endpoint must win over the shipped pool.
    expect(registry.getEndpoints(1, 'rpc')[0]).toBe('http://localhost:8545');
  });
});

describe('invalidate', () => {
  test('a query after invalidate reflects the new file state', () => {
    expect(registry.getNetwork(1).verification.primary).toBe('colibri');
    setFiles({ userConfig: { networks: { '1': { verification: { primary: 'direct' } } } } });
    expect(registry.getNetwork(1).verification.primary).toBe('direct');
  });
});

describe('mutation layer', () => {
  test('updateNetwork persists a verification override', () => {
    registry.updateNetwork(1, { verification: { primary: 'quorum' } });
    expect(registry.getNetwork(1).verification.primary).toBe('quorum');
    const written = mockWriteFileSync.mock.calls.find(([p]) => String(p).endsWith('network-config.json'));
    expect(written).toBeDefined();
  });

  test('updateNetwork merges a partial quorum patch, keeping the rest', () => {
    registry.updateNetwork(1, { quorum: { k: 7 } });
    expect(registry.getNetwork(1).quorum).toMatchObject({ k: 7, m: 2, timeoutMs: 5000 });
  });

  test('upsertEndpointSource adds a user source visible to getEndpoints', () => {
    registry.upsertEndpointSource('my-rpc', {
      role: 'rpc', keyed: false, coverage: { '1': 'http://my-rpc.example' },
    });
    expect(registry.getEndpoints(1, 'rpc')).toContain('http://my-rpc.example');
  });

  test('upsertEndpointSource un-hides a previously removed builtin', () => {
    setFiles({ userConfig: { removedSources: ['eth-public'] } });
    registry.upsertEndpointSource('eth-public', {
      role: 'rpc', keyed: false, coverage: { '1': 'http://override.example' },
    });
    expect(registry.getEndpoints(1, 'rpc')).toContain('http://override.example');
  });

  test('removeEndpointSource hides a builtin source', () => {
    registry.removeEndpointSource('eth-public');
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('https://eth.public.example');
  });

  test('removeEndpointSource deletes a user-added source outright', () => {
    setFiles({
      userConfig: {
        endpointSources: { u1: { role: 'rpc', keyed: false, coverage: { '1': 'http://u1.example' } } },
      },
    });
    registry.removeEndpointSource('u1');
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('http://u1.example');
  });

  test('restoreEndpointSource un-hides a removed builtin', () => {
    registry.removeEndpointSource('eth-public');
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('https://eth.public.example');
    registry.restoreEndpointSource('eth-public');
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://eth.public.example');
  });
});

describe('legacy-config migration on load', () => {
  test('absent network-config.json + legacy settings.json → migrates and persists', () => {
    // A quorum-era custom-RPC user: no network-config.json yet.
    setFiles({ settings: { enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' } });
    expect(registry.getNetwork(1).verification.primary).toBe('direct');
    expect(registry.getEndpoints(1, 'rpc')).toContain('http://localhost:8545');
    // network-config.json was written out.
    const written = mockWriteFileSync.mock.calls.find(([p]) => String(p).endsWith('network-config.json'));
    expect(written).toBeDefined();
  });

  test('no settings.json (fresh install) → no migration, no write', () => {
    setFiles();
    registry.getNetwork(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  test('network-config.json already present → migration is skipped', () => {
    setFiles({
      settings: { enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' },
      userConfig: { networks: { '1': { verification: { primary: 'quorum' } } } },
    });
    expect(registry.getNetwork(1).verification.primary).toBe('quorum');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  test('corrupt network-config.json → defaults, no re-migration, file left intact', () => {
    setFiles({ settings: { enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' } });
    mockFiles['network-config.json'] = '{ this is not valid json';
    registry.invalidate();
    // Builtin default — NOT the migrated 'direct', and the corrupt file is
    // not overwritten by a re-migration.
    expect(registry.getNetwork(1).verification.primary).toBe('colibri');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  test('migration write failure → migrated config still used in-memory', () => {
    setFiles({ settings: { enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' } });
    mockWriteFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(registry.getNetwork(1).verification.primary).toBe('direct');
    expect(registry.getEndpoints(1, 'rpc')).toContain('http://localhost:8545');
  });
});
