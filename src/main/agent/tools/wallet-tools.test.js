jest.mock('electron', () => ({}), { virtual: true });

jest.mock('../../identity-manager', () => ({
  getActiveWalletAddress: jest.fn(),
  getActiveWalletIndex: jest.fn(),
  getDerivedWallets: jest.fn(),
}));

jest.mock('../../wallet/balance-service', () => ({
  getNativeBalance: jest.fn(),
  getTokenBalancesForChain: jest.fn(),
}));

jest.mock('../../wallet/chains', () => ({
  getChain: jest.fn(),
  getAllChains: jest.fn(),
}));

jest.mock('../../chain-registry', () => ({
  isChainAvailable: jest.fn(),
}));

const { Type } = require('typebox');
const identityManager = require('../../identity-manager');
const balanceService = require('../../wallet/balance-service');
const chainsModule = require('../../wallet/chains');
const chainRegistry = require('../../chain-registry');

const { createWalletTools, _internals } = require('./wallet-tools');
const { TIERS } = require('../tool-tiers');

function makeTools() {
  const arr = createWalletTools({ Type });
  return Object.fromEntries(arr.map((t) => [t.name, t]));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('tool catalog', () => {
  test('exposes the five expected tools', () => {
    const tools = makeTools();
    expect(Object.keys(tools).sort()).toEqual(
      [
        'wallet_get_account',
        'wallet_get_balance',
        'wallet_get_token_balances',
        'wallet_list_chains',
        'wallet_get_chain',
      ].sort()
    );
  });

  test('every tool is tier WALLET_READ', () => {
    for (const t of Object.values(makeTools())) {
      expect(t.tier).toBe(TIERS.WALLET_READ);
    }
  });

  test('every tool has label, description, parameters, snippet, and at least one guideline', () => {
    for (const t of Object.values(makeTools())) {
      expect(typeof t.label).toBe('string');
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.parameters).toBe('object');
      expect(typeof t.promptSnippet).toBe('string');
      expect(t.promptSnippet.length).toBeGreaterThan(5);
      expect(Array.isArray(t.promptGuidelines)).toBe(true);
      expect(t.promptGuidelines.length).toBeGreaterThan(0);
    }
  });
});

describe('wallet_get_account', () => {
  test('returns the active wallet address, index, and name', async () => {
    identityManager.getActiveWalletAddress.mockResolvedValue('0xabc');
    identityManager.getActiveWalletIndex.mockReturnValue(2);
    identityManager.getDerivedWallets.mockResolvedValue([
      { index: 0, name: 'Main Wallet', address: '0xmain' },
      { index: 2, name: 'Trading', address: '0xabc' },
    ]);
    const result = await makeTools().wallet_get_account.execute('c1', {});
    expect(result.details).toEqual({ address: '0xabc', walletIndex: 2, name: 'Trading' });
  });

  test('falls back to a null name when the active index is not in the derived list', async () => {
    identityManager.getActiveWalletAddress.mockResolvedValue('0xorphan');
    identityManager.getActiveWalletIndex.mockReturnValue(99);
    identityManager.getDerivedWallets.mockResolvedValue([
      { index: 0, name: 'Main Wallet', address: '0xmain' },
    ]);
    const result = await makeTools().wallet_get_account.execute('c1', {});
    expect(result.details.name).toBeNull();
  });

  test('throws the vault-locked hint when no active address is available', async () => {
    identityManager.getActiveWalletAddress.mockResolvedValue(null);
    identityManager.getDerivedWallets.mockResolvedValue([]);
    await expect(makeTools().wallet_get_account.execute('c1', {})).rejects.toThrow(
      _internals.VAULT_LOCKED_HINT
    );
  });
});

describe('wallet_get_balance', () => {
  test('returns the native balance using the active wallet by default', async () => {
    identityManager.getActiveWalletAddress.mockResolvedValue('0xactive');
    chainsModule.getChain.mockReturnValue({
      chainId: 1,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    balanceService.getNativeBalance.mockResolvedValue({
      raw: '1000000000000000000',
      formatted: '1.0',
      symbol: 'ETH',
      decimals: 18,
    });
    const result = await makeTools().wallet_get_balance.execute('c1', { chainId: 1 });
    expect(balanceService.getNativeBalance).toHaveBeenCalledWith(
      '0xactive',
      1,
      expect.objectContaining({ symbol: 'ETH' })
    );
    expect(result.details).toEqual({
      address: '0xactive',
      chainId: 1,
      symbol: 'ETH',
      decimals: 18,
      formatted: '1.0',
      raw: '1000000000000000000',
    });
  });

  test('uses an explicit address argument when provided (bypasses the active wallet)', async () => {
    chainsModule.getChain.mockReturnValue({
      chainId: 100,
      nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
    });
    balanceService.getNativeBalance.mockResolvedValue({
      raw: '5',
      formatted: '0.000000000000000005',
      symbol: 'xDAI',
      decimals: 18,
    });
    const result = await makeTools().wallet_get_balance.execute('c1', {
      chainId: 100,
      address: '0xfriend',
    });
    expect(identityManager.getActiveWalletAddress).not.toHaveBeenCalled();
    expect(result.details.address).toBe('0xfriend');
    expect(result.details.chainId).toBe(100);
  });

  test('throws on unknown chainId', async () => {
    identityManager.getActiveWalletAddress.mockResolvedValue('0xactive');
    chainsModule.getChain.mockReturnValue(null);
    await expect(
      makeTools().wallet_get_balance.execute('c1', { chainId: 9999 })
    ).rejects.toThrow(/unknown chainId 9999/);
  });

  test('throws the vault-locked hint when defaulting and no address is available', async () => {
    identityManager.getActiveWalletAddress.mockResolvedValue(null);
    chainsModule.getChain.mockReturnValue({ chainId: 1, nativeCurrency: { symbol: 'ETH', decimals: 18 } });
    await expect(
      makeTools().wallet_get_balance.execute('c1', { chainId: 1 })
    ).rejects.toThrow(_internals.VAULT_LOCKED_HINT);
  });
});

describe('wallet_get_token_balances', () => {
  test('returns the per-chain ERC-20 list from balance-service', async () => {
    identityManager.getActiveWalletAddress.mockResolvedValue('0xactive');
    balanceService.getTokenBalancesForChain.mockResolvedValue([
      { tokenAddress: '0xdBF3', symbol: 'BZZ', decimals: 16, formatted: '0.001', raw: '1000' },
      { tokenAddress: '0xUSDC', symbol: 'USDC', decimals: 6, formatted: '0', raw: '0' },
    ]);
    const result = await makeTools().wallet_get_token_balances.execute('c1', { chainId: 100 });
    expect(balanceService.getTokenBalancesForChain).toHaveBeenCalledWith('0xactive', 100);
    expect(result.details).toEqual({
      address: '0xactive',
      chainId: 100,
      balances: [
        { tokenAddress: '0xdBF3', symbol: 'BZZ', decimals: 16, formatted: '0.001', raw: '1000' },
        { tokenAddress: '0xUSDC', symbol: 'USDC', decimals: 6, formatted: '0', raw: '0' },
      ],
    });
  });

  test('passes the explicit address through (no active-wallet lookup)', async () => {
    balanceService.getTokenBalancesForChain.mockResolvedValue([]);
    await makeTools().wallet_get_token_balances.execute('c1', {
      chainId: 100,
      address: '0xfriend',
    });
    expect(identityManager.getActiveWalletAddress).not.toHaveBeenCalled();
    expect(balanceService.getTokenBalancesForChain).toHaveBeenCalledWith('0xfriend', 100);
  });

  test('throws the vault-locked hint when defaulting and no address is available', async () => {
    identityManager.getActiveWalletAddress.mockResolvedValue(null);
    await expect(
      makeTools().wallet_get_token_balances.execute('c1', { chainId: 1 })
    ).rejects.toThrow(_internals.VAULT_LOCKED_HINT);
  });
});

describe('error propagation', () => {
  test('rejects with the underlying balance-service error when getNativeBalance throws', async () => {
    identityManager.getActiveWalletAddress.mockResolvedValue('0xactive');
    chainsModule.getChain.mockReturnValue({
      chainId: 1,
      nativeCurrency: { symbol: 'ETH', decimals: 18 },
    });
    balanceService.getNativeBalance.mockRejectedValue(new Error('rpc unreachable'));
    await expect(
      makeTools().wallet_get_balance.execute('c1', { chainId: 1 })
    ).rejects.toThrow(/rpc unreachable/);
  });
});

describe('wallet_list_chains', () => {
  test('returns id, name, native symbol, explorer, and availability flag', async () => {
    chainsModule.getAllChains.mockReturnValue([
      {
        chainId: 1,
        name: 'Ethereum',
        nativeCurrency: { symbol: 'ETH' },
        blockExplorer: 'https://etherscan.io',
      },
      {
        chainId: 100,
        name: 'Gnosis',
        nativeCurrency: { symbol: 'xDAI' },
        blockExplorer: 'https://gnosisscan.io',
      },
    ]);
    chainRegistry.isChainAvailable.mockImplementation((id) => id === 1);
    const result = await makeTools().wallet_list_chains.execute('c1', {});
    expect(result.details.chains).toEqual([
      { chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH', blockExplorer: 'https://etherscan.io', isAvailable: true },
      { chainId: 100, name: 'Gnosis', nativeSymbol: 'xDAI', blockExplorer: 'https://gnosisscan.io', isAvailable: false },
    ]);
  });
});

describe('wallet_get_chain', () => {
  test('returns the full chain config for a known chain', async () => {
    chainsModule.getChain.mockReturnValue({
      chainId: 100,
      name: 'Gnosis',
      nativeCurrency: { symbol: 'xDAI', decimals: 18 },
      blockExplorer: 'https://gnosisscan.io',
      rpcUrls: ['https://rpc.gnosischain.com'],
      contracts: { bzzToken: '0xdBF3' },
    });
    const result = await makeTools().wallet_get_chain.execute('c1', { chainId: 100 });
    expect(result.details).toEqual({
      chainId: 100,
      name: 'Gnosis',
      nativeCurrency: { symbol: 'xDAI', decimals: 18 },
      blockExplorer: 'https://gnosisscan.io',
      rpcUrls: ['https://rpc.gnosischain.com'],
      contracts: { bzzToken: '0xdBF3' },
    });
  });

  test('throws on unknown chainId', async () => {
    chainsModule.getChain.mockReturnValue(null);
    await expect(
      makeTools().wallet_get_chain.execute('c1', { chainId: 9999 })
    ).rejects.toThrow(/unknown chainId 9999/);
  });
});
