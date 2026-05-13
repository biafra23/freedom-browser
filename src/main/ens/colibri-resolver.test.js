const mockGetPath = jest.fn();
jest.mock('electron', () => ({
  app: { getPath: (...args) => mockGetPath(...args) },
}));

const mockMkdirSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
jest.mock('node:fs', () => ({
  mkdirSync: (...args) => mockMkdirSync(...args),
  readFileSync: (...args) => mockReadFileSync(...args),
  writeFileSync: (...args) => mockWriteFileSync(...args),
  unlinkSync: (...args) => mockUnlinkSync(...args),
}));

// Mock-prefixed names so Jest's "out-of-scope variable" guard permits them
// in the factory (the factory runs before top-level `const` initializers).
const mockColibriCtor = jest.fn();
const mockRegisterStorage = jest.fn(() => Promise.resolve());
jest.mock('@corpus-core/colibri-stateless', () => {
  class FakeColibri {
    constructor(config) { mockColibriCtor(config); this.config = config; }
    static register_storage(storage) { return mockRegisterStorage(storage); }
  }
  return {
    __esModule: true,
    default: FakeColibri,
    Strategy: { VerifiedOnly: Symbol('VerifiedOnly') },
  };
});
const { Strategy } = require('@corpus-core/colibri-stateless');

const mockBrowserProvider = jest.fn().mockImplementation((client) => ({ kind: 'browser-provider', client }));
jest.mock('ethers', () => ({
  ethers: { BrowserProvider: mockBrowserProvider },
}));

const mockLoadSettings = jest.fn();
jest.mock('../settings-store', () => ({
  loadSettings: (...args) => mockLoadSettings(...args),
}));

// Surgical: only stub the two symbols this module imports. Re-exporting the
// whole ens-resolver here would pull every ENS dependency into the test.
const mockUniversalResolverCall = jest.fn();
jest.mock('../ens-resolver', () => ({
  universalResolverCall: (...args) => mockUniversalResolverCall(...args),
  hostOf: (url) => { try { return new URL(url).host; } catch { return url; } },
}));

const { resolveViaColibri, clearColibriClientForTest, DEFAULT_PROVER_URL } = require('./colibri-resolver');

const DEFAULTS = {
  ensColibriProverUrl: '',
  ensColibriZkProof: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  clearColibriClientForTest();
  mockGetPath.mockReturnValue('/tmp/freedom-test-userdata');
  mockLoadSettings.mockReturnValue({ ...DEFAULTS });
  mockUniversalResolverCall.mockResolvedValue({
    resolvedData: '0xdeadbeef',
    resolverAddress: '0x000000000000000000000000000000000000ffff',
  });
});

describe('resolveViaColibri', () => {
  test('constructs the client lazily with the partner-confirmed config', async () => {
    expect(mockColibriCtor).not.toHaveBeenCalled();
    await resolveViaColibri('vitalik.eth', '0xbc1c58d1...');
    expect(mockColibriCtor).toHaveBeenCalledTimes(1);
    expect(mockColibriCtor).toHaveBeenCalledWith({
      chainId: 1,
      prover: [DEFAULT_PROVER_URL],
      zk_proof: true,
      privacy_mode: 'basic',
      proofStrategy: Strategy.VerifiedOnly,
    });
  });

  test('registers disk storage exactly once and before the first client constructor', async () => {
    await resolveViaColibri('a.eth', '0x');
    await resolveViaColibri('b.eth', '0x');
    expect(mockRegisterStorage).toHaveBeenCalledTimes(1);
    expect(mockRegisterStorage.mock.invocationCallOrder[0])
      .toBeLessThan(mockColibriCtor.mock.invocationCallOrder[0]);
  });

  test('does not re-register storage on a settings-driven rebuild', async () => {
    await resolveViaColibri('a.eth', '0x');
    mockLoadSettings.mockReturnValue({ ...DEFAULTS, ensColibriZkProof: false });
    await resolveViaColibri('b.eth', '0x');
    expect(mockRegisterStorage).toHaveBeenCalledTimes(1);
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
  });

  test('reuses the singleton across calls when settings are unchanged', async () => {
    await resolveViaColibri('one.eth', '0x');
    await resolveViaColibri('two.eth', '0x');
    expect(mockColibriCtor).toHaveBeenCalledTimes(1);
    expect(mockBrowserProvider).toHaveBeenCalledTimes(1);
  });

  test('concurrent first calls collapse onto one construction', async () => {
    const [a, b, c] = await Promise.all([
      resolveViaColibri('a.eth', '0x'),
      resolveViaColibri('b.eth', '0x'),
      resolveViaColibri('c.eth', '0x'),
    ]);
    expect(mockColibriCtor).toHaveBeenCalledTimes(1);
    expect(mockRegisterStorage).toHaveBeenCalledTimes(1);
    expect(mockBrowserProvider).toHaveBeenCalledTimes(1);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
  });

  test('rebuilds the client when the prover URL changes', async () => {
    await resolveViaColibri('one.eth', '0x');
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://other-prover.example',
    });
    await resolveViaColibri('two.eth', '0x');
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
    expect(mockColibriCtor.mock.calls[1][0].prover).toEqual(['https://other-prover.example']);
    expect(mockBrowserProvider).toHaveBeenCalledTimes(2);
  });

  test('rebuilds the client when zk_proof toggles', async () => {
    await resolveViaColibri('one.eth', '0x');
    mockLoadSettings.mockReturnValue({ ...DEFAULTS, ensColibriZkProof: false });
    await resolveViaColibri('two.eth', '0x');
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
    expect(mockColibriCtor.mock.calls[1][0].zk_proof).toBe(false);
  });

  test('respects a custom prover URL from settings', async () => {
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://custom.example/keyXYZ',
    });
    await resolveViaColibri('a.eth', '0x');
    expect(mockColibriCtor.mock.calls[0][0].prover).toEqual(['https://custom.example/keyXYZ']);
  });

  test('passes name + callData through to universalResolverCall via the cached BrowserProvider', async () => {
    await resolveViaColibri('vitalik.eth', '0xbc1c58d1deadbeef');
    expect(mockUniversalResolverCall).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'browser-provider' }),
      'vitalik.eth',
      '0xbc1c58d1deadbeef',
    );
  });

  test('returns the universalResolverCall payload verbatim', async () => {
    const payload = {
      resolvedData: '0xfeedface',
      resolverAddress: '0x000000000000000000000000000000000000beef',
    };
    mockUniversalResolverCall.mockResolvedValue(payload);
    await expect(resolveViaColibri('a.eth', '0x')).resolves.toEqual(payload);
  });

  test('propagates errors from universalResolverCall (e.g. verification failure)', async () => {
    const err = new Error('proof verification failed');
    mockUniversalResolverCall.mockRejectedValue(err);
    await expect(resolveViaColibri('a.eth', '0x')).rejects.toBe(err);
  });
});

describe('disk storage adapter', () => {
  // Captured from the register_storage call after triggering construction.
  // No public export — the integration assertion (passed to register_storage)
  // is more valuable than unit-testing the adapter in isolation.
  async function captureStorage() {
    await resolveViaColibri('a.eth', '0x');
    return mockRegisterStorage.mock.calls[0][0];
  }

  test('creates the colibri subdirectory under app userData on first use', async () => {
    await captureStorage();
    expect(mockGetPath).toHaveBeenCalledWith('userData');
    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/tmp/freedom-test-userdata/colibri',
      { recursive: true },
    );
  });

  test('get/set/del route through fs against the colibri subdirectory', async () => {
    const storage = await captureStorage();
    mockReadFileSync.mockReturnValue(Buffer.from([1, 2, 3]));
    expect(storage.get('states_1')).toEqual(Buffer.from([1, 2, 3]));
    expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/freedom-test-userdata/colibri/states_1');

    storage.set('sync_1_42', new Uint8Array([9, 9]));
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/freedom-test-userdata/colibri/sync_1_42',
      new Uint8Array([9, 9]),
    );

    storage.del('states_1');
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/freedom-test-userdata/colibri/states_1');
  });

  test('get returns null when the underlying file is missing (warm-cache miss)', async () => {
    const storage = await captureStorage();
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    expect(storage.get('missing')).toBeNull();
  });

  test('del absorbs ENOENT but rethrows other errors (e.g. permission)', async () => {
    const storage = await captureStorage();
    mockUnlinkSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    expect(() => storage.del('already-gone')).not.toThrow();

    mockUnlinkSync.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    expect(() => storage.del('locked')).toThrow(/EACCES/);
  });
});
