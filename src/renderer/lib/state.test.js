describe('renderer state', () => {
  const originalWindow = global.window;

  const loadModule = async (nodeConfig = {}) => {
    jest.resetModules();
    global.window = { nodeConfig };
    return import('./state.js');
  };

  afterEach(() => {
    global.window = originalWindow;
  });

  test('uses a synthetic native IPFS base and leaves other prefixes unset until config', async () => {
    const defaults = await loadModule();
    expect(defaults.state.bzzRoutePrefix).toBeNull();
    expect(defaults.state.ipfsRoutePrefix).toBe('http://freedom-ipfs.localhost/ipfs/');
    expect(defaults.state.ipnsRoutePrefix).toBe('http://freedom-ipfs.localhost/ipns/');
    expect(defaults.state.radicleApiPrefix).toBeNull();

    const custom = await loadModule({
      antApi: 'http://127.0.0.1:1733/',
    });
    expect(custom.state.bzzRoutePrefix).toBe('http://127.0.0.1:1733/bzz/');
    expect(custom.state.ipfsRoutePrefix).toBe('http://freedom-ipfs.localhost/ipfs/');
    expect(custom.state.ipnsRoutePrefix).toBe('http://freedom-ipfs.localhost/ipns/');
  });

  test('builds service urls from registry values and rejects missing endpoints', async () => {
    const mod = await loadModule();

    expect(() => mod.buildAntUrl('/health')).toThrow('Ant endpoint is not ready');
    expect(() => mod.buildIpfsApiUrl('/api/v0/id')).toThrow(
      'IPFS API endpoint is not ready'
    );
    expect(() => mod.buildRadicleUrl('/api/v1')).toThrow('Radicle endpoint is not ready');

    mod.updateRegistry({
      ant: { api: 'http://127.0.0.1:1999', gateway: 'http://127.0.0.1:1999' },
      ipfs: { api: 'http://127.0.0.1:5999', gateway: 'http://127.0.0.1:8999' },
      radicle: { api: 'http://127.0.0.1:8781', gateway: 'http://127.0.0.1:8781' },
    });

    expect(mod.buildAntUrl('/health')).toBe('http://127.0.0.1:1999/health');
    expect(mod.buildIpfsApiUrl('/api/v0/id')).toBe('http://127.0.0.1:5999/api/v0/id');
    expect(mod.buildRadicleUrl('/api/v1')).toBe('http://127.0.0.1:8781/api/v1');
    expect(mod.state.antBase).toBe('http://127.0.0.1:1999');
    expect(mod.state.ipfsBase).toBe('http://127.0.0.1:8999');
    expect(mod.state.ipfsApiBase).toBe('http://127.0.0.1:5999');
    expect(mod.state.radicleBase).toBe('http://127.0.0.1:8781');
  });

  test('normalizes the radicle feature flag and service display messages', async () => {
    const mod = await loadModule();

    mod.setRadicleIntegrationEnabled(true);
    expect(mod.state.enableRadicleIntegration).toBe(true);

    mod.setRadicleIntegrationEnabled('yes');
    expect(mod.state.enableRadicleIntegration).toBe(false);

    mod.updateRegistry({
      ...mod.state.registry,
      ant: {
        api: null,
        gateway: null,
        mode: 'none',
        statusMessage: 'Ready',
        tempMessage: 'Starting',
      },
    });

    expect(mod.getDisplayMessage('ant')).toBe('Starting');
    expect(mod.getDisplayMessage('missing')).toBeNull();
  });
});
