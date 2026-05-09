const mockFromId = jest.fn();

jest.mock('electron', () => ({
  webContents: {
    fromId: (...args) => mockFromId(...args),
  },
}));

jest.mock('../../identity-manager', () => ({
  getActiveWalletAddress: jest.fn(),
  getActiveWalletIndex: jest.fn(),
  getDerivedWallets: jest.fn(),
  loadIdentityModule: jest.fn(),
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

const mockIdentityModule = {
  isUnlocked: jest.fn(),
  exportPrivateKey: jest.fn(),
};

jest.mock('../../wallet/transaction-service', () => ({
  signPersonalMessage: jest.fn(),
}));

jest.mock('../../vault-timer', () => ({
  resetVaultAutoLockTimer: jest.fn(),
}));

jest.mock('../vault-unlock-bridge', () => ({
  requestVaultUnlock: jest.fn(),
}));

jest.mock('../../ens-resolver', () => ({
  resolveEnsAddress: jest.fn(),
  resolveEnsReverse: jest.fn(),
  resolveEnsContent: jest.fn(),
  ENS_REASONS: Object.freeze({
    NOT_FOUND: 'NOT_FOUND',
    INVALID_NAME: 'INVALID_NAME',
    INVALID_ADDRESS: 'INVALID_ADDRESS',
    RESOLUTION_ERROR: 'RESOLUTION_ERROR',
  }),
  ENS_RESULT_TYPES: Object.freeze({
    OK: 'ok',
    NOT_FOUND: 'not_found',
    UNSUPPORTED: 'unsupported',
    CONFLICT: 'conflict',
    ERROR: 'error',
  }),
}));

const { Type } = require('typebox');
const identityManager = require('../../identity-manager');
const balanceService = require('../../wallet/balance-service');
const chainsModule = require('../../wallet/chains');
const chainRegistry = require('../../chain-registry');
const ensResolver = require('../../ens-resolver');
const transactionService = require('../../wallet/transaction-service');
const vaultTimer = require('../../vault-timer');
const vaultUnlockBridge = require('../vault-unlock-bridge');

const { createWalletTools, _internals } = require('./wallet-tools');
const { TIERS } = require('../tool-tiers');

function makeTools(opts = {}) {
  const arr = createWalletTools({ hostWebContentsId: 7, Type, ...opts });
  return Object.fromEntries(arr.map((t) => [t.name, t]));
}

function fakeWalletBridge() {
  return {
    isDestroyed: () => false,
    executeJavaScript: jest.fn(async () => true),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentityModule.isUnlocked.mockReset();
  mockIdentityModule.exportPrivateKey.mockReset();
  identityManager.loadIdentityModule.mockResolvedValue(mockIdentityModule);
});

describe('tool catalog', () => {
  test('exposes the eleven expected tools', () => {
    const tools = makeTools();
    expect(Object.keys(tools).sort()).toEqual(
      [
        'wallet_get_account',
        'wallet_list_accounts',
        'wallet_get_balance',
        'wallet_get_token_balances',
        'wallet_list_chains',
        'wallet_get_chain',
        'wallet_switch_chain',
        'ens_resolve',
        'ens_reverse',
        'ens_resolve_contenthash',
        'wallet_sign_message',
      ].sort()
    );
  });

  test('tiers split: read tools WALLET_READ, switch_chain BROWSER_MUTATION, sign IDENTITY_OR_SIGNING', () => {
    const tools = makeTools();
    for (const name of [
      'wallet_get_account',
      'wallet_list_accounts',
      'wallet_get_balance',
      'wallet_get_token_balances',
      'wallet_list_chains',
      'wallet_get_chain',
      'ens_resolve',
      'ens_reverse',
      'ens_resolve_contenthash',
    ]) {
      expect(tools[name].tier).toBe(TIERS.WALLET_READ);
    }
    expect(tools.wallet_switch_chain.tier).toBe(TIERS.BROWSER_MUTATION);
    expect(tools.wallet_sign_message.tier).toBe(TIERS.IDENTITY_OR_SIGNING);
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

describe('wallet_list_accounts', () => {
  test('returns the derived wallet list and the active index', async () => {
    identityManager.getDerivedWallets.mockResolvedValue([
      { index: 0, name: 'Main Wallet', address: '0xmain' },
      { index: 1, name: 'Trading', address: '0xabc' },
    ]);
    identityManager.getActiveWalletIndex.mockReturnValue(1);
    const result = await makeTools().wallet_list_accounts.execute('c1', {});
    expect(result.details).toEqual({
      activeIndex: 1,
      wallets: [
        { index: 0, name: 'Main Wallet', address: '0xmain' },
        { index: 1, name: 'Trading', address: '0xabc' },
      ],
    });
  });

  test('returns an empty wallet list with activeIndex defaulting to 0 when no vault exists yet', async () => {
    identityManager.getDerivedWallets.mockResolvedValue([]);
    identityManager.getActiveWalletIndex.mockReturnValue(0);
    const result = await makeTools().wallet_list_accounts.execute('c1', {});
    expect(result.details).toEqual({ activeIndex: 0, wallets: [] });
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

describe('wallet_switch_chain', () => {
  test('validates chainId and routes through the wallet bridge with a true result', async () => {
    chainsModule.getChain.mockReturnValue({ chainId: 100, name: 'Gnosis' });
    const wc = fakeWalletBridge();
    mockFromId.mockReturnValue(wc);
    const result = await makeTools().wallet_switch_chain.execute('c1', { chainId: 100 });
    expect(result.details).toEqual({ chainId: 100, name: 'Gnosis' });
    const code = wc.executeJavaScript.mock.calls[0][0];
    expect(code).toContain("window.__agentWalletBridge__");
    expect(code).toContain('setActiveChain(100)');
  });

  test('rejects unknown chainId before touching the bridge', async () => {
    chainsModule.getChain.mockReturnValue(null);
    const wc = fakeWalletBridge();
    mockFromId.mockReturnValue(wc);
    await expect(
      makeTools().wallet_switch_chain.execute('c1', { chainId: 9999 })
    ).rejects.toThrow(/unknown chainId 9999/);
    expect(wc.executeJavaScript).not.toHaveBeenCalled();
  });

  test('rejects when the bridge returns falsy (refused)', async () => {
    chainsModule.getChain.mockReturnValue({ chainId: 100, name: 'Gnosis' });
    const wc = fakeWalletBridge();
    wc.executeJavaScript.mockResolvedValue(false);
    mockFromId.mockReturnValue(wc);
    await expect(
      makeTools().wallet_switch_chain.execute('c1', { chainId: 100 })
    ).rejects.toThrow(/refused chain 100/);
  });

  test('rejects with the bridge __error sentinel from the renderer', async () => {
    chainsModule.getChain.mockReturnValue({ chainId: 100, name: 'Gnosis' });
    const wc = fakeWalletBridge();
    wc.executeJavaScript.mockResolvedValue({ __error: 'wallet bridge unavailable' });
    mockFromId.mockReturnValue(wc);
    await expect(
      makeTools().wallet_switch_chain.execute('c1', { chainId: 100 })
    ).rejects.toThrow(/wallet bridge unavailable/);
  });
});

describe('ens_resolve', () => {
  test('returns name and address on success', async () => {
    ensResolver.resolveEnsAddress.mockResolvedValue({
      success: true,
      name: 'vitalik.eth',
      address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    });
    const result = await makeTools().ens_resolve.execute('c1', { name: 'vitalik.eth' });
    expect(result.details).toEqual({
      name: 'vitalik.eth',
      address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    });
  });

  test('throws "no address record" on NOT_FOUND', async () => {
    ensResolver.resolveEnsAddress.mockResolvedValue({
      success: false,
      name: 'never-registered.eth',
      reason: 'NOT_FOUND',
    });
    await expect(
      makeTools().ens_resolve.execute('c1', { name: 'never-registered.eth' })
    ).rejects.toThrow(/No address record for never-registered\.eth/);
  });

  test('throws "Invalid ENS name" on INVALID_NAME', async () => {
    ensResolver.resolveEnsAddress.mockResolvedValue({
      success: false,
      name: '!!bad!!',
      reason: 'INVALID_NAME',
      error: 'disallowed character',
    });
    await expect(
      makeTools().ens_resolve.execute('c1', { name: '!!bad!!' })
    ).rejects.toThrow(/Invalid ENS name: !!bad!!.*disallowed character/);
  });

  test('throws with the resolver reason on other failures', async () => {
    ensResolver.resolveEnsAddress.mockResolvedValue({
      success: false,
      name: 'x.eth',
      reason: 'RESOLUTION_ERROR',
      error: 'all providers timed out',
    });
    await expect(
      makeTools().ens_resolve.execute('c1', { name: 'x.eth' })
    ).rejects.toThrow(/ENS resolve failed \(RESOLUTION_ERROR\).*all providers timed out/);
  });
});

describe('ens_reverse', () => {
  test('returns address and primary name on success', async () => {
    ensResolver.resolveEnsReverse.mockResolvedValue({
      success: true,
      address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
      name: 'vitalik.eth',
    });
    const result = await makeTools().ens_reverse.execute('c1', {
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    });
    expect(result.details.name).toBe('vitalik.eth');
  });

  test('throws "no primary ENS name" on NOT_FOUND', async () => {
    ensResolver.resolveEnsReverse.mockResolvedValue({
      success: false,
      address: '0x0000000000000000000000000000000000000001',
      reason: 'NOT_FOUND',
    });
    await expect(
      makeTools().ens_reverse.execute('c1', {
        address: '0x0000000000000000000000000000000000000001',
      })
    ).rejects.toThrow(/No primary ENS name/);
  });

  test('throws "Invalid Ethereum address" on INVALID_ADDRESS', async () => {
    ensResolver.resolveEnsReverse.mockResolvedValue({
      success: false,
      address: 'not-an-address',
      reason: 'INVALID_ADDRESS',
      error: 'Invalid address: not-an-address',
    });
    await expect(
      makeTools().ens_reverse.execute('c1', { address: 'not-an-address' })
    ).rejects.toThrow(/Invalid Ethereum address: not-an-address/);
  });
});

describe('ens_resolve_contenthash', () => {
  test('returns name, uri, protocol, decoded on type:ok', async () => {
    ensResolver.resolveEnsContent.mockResolvedValue({
      type: 'ok',
      name: 'vitalik.eth',
      codec: 'ipfs-ns',
      protocol: 'ipfs',
      uri: 'ipfs://QmFoo',
      decoded: 'QmFoo',
      trust: 'verified',
    });
    const result = await makeTools().ens_resolve_contenthash.execute('c1', {
      name: 'vitalik.eth',
    });
    expect(result.details).toEqual({
      name: 'vitalik.eth',
      uri: 'ipfs://QmFoo',
      protocol: 'ipfs',
      decoded: 'QmFoo',
    });
  });

  test('throws "No contenthash record" on type:not_found', async () => {
    ensResolver.resolveEnsContent.mockResolvedValue({
      type: 'not_found',
      reason: 'NO_RESOLVER',
      name: 'plain.eth',
    });
    await expect(
      makeTools().ens_resolve_contenthash.execute('c1', { name: 'plain.eth' })
    ).rejects.toThrow(/No contenthash record for plain\.eth.*NO_RESOLVER/);
  });

  test('throws "unsupported codec" on type:unsupported', async () => {
    ensResolver.resolveEnsContent.mockResolvedValue({
      type: 'unsupported',
      reason: 'UNSUPPORTED_CONTENTHASH_FORMAT',
      name: 'weird.eth',
    });
    await expect(
      makeTools().ens_resolve_contenthash.execute('c1', { name: 'weird.eth' })
    ).rejects.toThrow(/unsupported codec/);
  });

  test('treats type:conflict as a security signal with an explicit error', async () => {
    ensResolver.resolveEnsContent.mockResolvedValue({
      type: 'conflict',
      name: 'attacked.eth',
      groups: [{ value: 'a' }, { value: 'b' }],
    });
    await expect(
      makeTools().ens_resolve_contenthash.execute('c1', { name: 'attacked.eth' })
    ).rejects.toThrow(/RPC quorum failed.*conflicting.*untrusted/);
  });
});

describe('wallet_sign_message', () => {
  function setupHappyPath() {
    identityManager.getDerivedWallets.mockResolvedValue([
      { index: 0, name: 'Main Wallet', address: '0xMAINabcdef0123456789' },
      { index: 1, name: 'Trading', address: '0xTRADINGfedcba9876543' },
    ]);
    identityManager.getActiveWalletAddress.mockResolvedValue('0xMAINabcdef0123456789');
    identityManager.getActiveWalletIndex.mockReturnValue(0);
    mockIdentityModule.isUnlocked.mockReturnValue(true);
    mockIdentityModule.exportPrivateKey.mockReturnValue('0xprivatekey');
    transactionService.signPersonalMessage.mockResolvedValue('0xSIGNATURE');
  }

  test('signs with the active wallet by default and resets the auto-lock timer', async () => {
    setupHappyPath();
    const result = await makeTools().wallet_sign_message.execute(
      'c1',
      { message: 'Hello', reason: 'prove ownership for SIWE' }
    );
    expect(transactionService.signPersonalMessage).toHaveBeenCalledWith('Hello', '0xprivatekey');
    expect(mockIdentityModule.exportPrivateKey).toHaveBeenCalledWith(0);
    expect(vaultTimer.resetVaultAutoLockTimer).toHaveBeenCalledTimes(1);
    expect(result.details).toEqual({
      address: '0xMAINabcdef0123456789',
      signature: '0xSIGNATURE',
    });
  });

  test('signs with a non-active wallet when address parameter matches a derived account', async () => {
    setupHappyPath();
    await makeTools().wallet_sign_message.execute(
      'c1',
      {
        message: 'Hello',
        reason: 'prove ownership',
        address: '0xtradingfedcba9876543', // case-insensitive match
      }
    );
    expect(mockIdentityModule.exportPrivateKey).toHaveBeenCalledWith(1);
  });

  test('rejects when the requested address is not in the user\'s derived wallets', async () => {
    setupHappyPath();
    await expect(
      makeTools().wallet_sign_message.execute(
        'c1',
        { message: 'Hello', reason: 'r', address: '0xNotMine' }
      )
    ).rejects.toThrow(/not one of the user's derived wallets/);
    expect(transactionService.signPersonalMessage).not.toHaveBeenCalled();
  });

  test('vault locked → calls vault-unlock bridge before signing', async () => {
    setupHappyPath();
    // Locked at first check → after bridge resolves, unlocked
    mockIdentityModule.isUnlocked.mockReturnValueOnce(false).mockReturnValue(true);
    vaultUnlockBridge.requestVaultUnlock.mockResolvedValue();
    await makeTools().wallet_sign_message.execute(
      'c1',
      { message: 'Hi', reason: 'because' }
    );
    expect(vaultUnlockBridge.requestVaultUnlock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostWebContentsId: 7,
        reason: expect.stringContaining('Sign a message'),
      })
    );
    expect(transactionService.signPersonalMessage).toHaveBeenCalled();
  });

  test('vault re-locks between unlock and sign → throws "Vault locked again" without leaking the key', async () => {
    setupHappyPath();
    // First check: locked → bridge resolves "unlocked" → re-check: locked again
    // (auto-lock timer fired, or external lock — defensive branch).
    mockIdentityModule.isUnlocked
      .mockReturnValueOnce(false) // initial check
      .mockReturnValueOnce(false); // post-unlock re-check
    vaultUnlockBridge.requestVaultUnlock.mockResolvedValue();
    await expect(
      makeTools().wallet_sign_message.execute(
        'c1',
        { message: 'Hi', reason: 'because' }
      )
    ).rejects.toThrow(/Vault locked again before signing/);
    expect(transactionService.signPersonalMessage).not.toHaveBeenCalled();
    expect(mockIdentityModule.exportPrivateKey).not.toHaveBeenCalled();
  });

  test('vault locked → user cancels unlock → tool throws and signing is skipped', async () => {
    setupHappyPath();
    mockIdentityModule.isUnlocked.mockReturnValue(false);
    vaultUnlockBridge.requestVaultUnlock.mockRejectedValue(
      new Error('Vault unlock cancelled by user')
    );
    await expect(
      makeTools().wallet_sign_message.execute(
        'c1',
        { message: 'Hi', reason: 'because' }
      )
    ).rejects.toThrow(/cancelled by user/);
    expect(transactionService.signPersonalMessage).not.toHaveBeenCalled();
    expect(vaultTimer.resetVaultAutoLockTimer).not.toHaveBeenCalled();
  });

  test('formatConsentDescription includes target wallet, reason, and a truncated message', () => {
    const fmt = makeTools().wallet_sign_message.formatConsentDescription;
    const desc = fmt({
      message: 'a'.repeat(120),
      reason: 'log in to MySite',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    });
    expect(desc).toContain('0xd8dA…6045');
    expect(desc).toContain('Reason: log in to MySite');
    expect(desc).toContain('"' + 'a'.repeat(80) + '…"');
  });

  test('formatConsentDescription says "the active wallet" when no address override is given', () => {
    const fmt = makeTools().wallet_sign_message.formatConsentDescription;
    const desc = fmt({ message: 'Hi', reason: 'reason' });
    expect(desc).toContain('the active wallet');
    expect(desc).not.toContain('0x');
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
