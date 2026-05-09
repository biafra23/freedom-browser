jest.mock('../../chain-registry', () => ({
  getToken: jest.fn(),
  getTokenKey: (chainId, address) => `${chainId}:${address}`,
}));

const chainRegistry = require('../../chain-registry');
const { decodeErc20Transfer, decodeErc20Approve, decodeKnownAction } = require('./wallet-tx-decode');

beforeEach(() => {
  jest.clearAllMocks();
});

const RECIP_PADDED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SPENDER_PADDED = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// 1_000_000 in 32 bytes
const ONE_MILLION_HEX = '00000000000000000000000000000000000000000000000000000000000f4240';

const TRANSFER_DATA = '0xa9059cbb' + '000000000000000000000000' + RECIP_PADDED + ONE_MILLION_HEX;
const APPROVE_DATA = '0x095ea7b3' + '000000000000000000000000' + SPENDER_PADDED + ONE_MILLION_HEX;

describe('decodeErc20Transfer', () => {
  test('decodes recipient + raw amount + token metadata when registered', () => {
    chainRegistry.getToken.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    const out = decodeErc20Transfer({ to: '0xUSDC', data: TRANSFER_DATA, chainId: 1 });
    expect(out.kind).toBe('erc20-transfer');
    expect(out.recipient.toLowerCase()).toBe('0x' + RECIP_PADDED);
    expect(out.rawAmount).toBe('1000000');
    expect(out.tokenSymbol).toBe('USDC');
    expect(out.tokenDecimals).toBe(6);
    expect(out.formattedAmount).toBe('1.0');
  });

  test('returns null tokenSymbol/decimals/formattedAmount when token is unknown to the registry', () => {
    chainRegistry.getToken.mockReturnValue(null);
    const out = decodeErc20Transfer({ to: '0xUNKNOWN', data: TRANSFER_DATA, chainId: 1 });
    expect(out.tokenSymbol).toBeNull();
    expect(out.tokenDecimals).toBeNull();
    expect(out.formattedAmount).toBeNull();
    expect(out.rawAmount).toBe('1000000');
  });

  test('returns null when data is not a transfer call', () => {
    expect(decodeErc20Transfer({ to: '0xUSDC', data: '0xdeadbeef', chainId: 1 })).toBeNull();
    expect(decodeErc20Transfer({ to: '0xUSDC', data: '0x', chainId: 1 })).toBeNull();
    expect(decodeErc20Transfer({ to: '0xUSDC', data: undefined, chainId: 1 })).toBeNull();
  });
});

describe('decodeErc20Approve', () => {
  test('decodes spender + raw amount + token metadata', () => {
    chainRegistry.getToken.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    const out = decodeErc20Approve({ to: '0xUSDC', data: APPROVE_DATA, chainId: 1 });
    expect(out.kind).toBe('erc20-approve');
    expect(out.spender.toLowerCase()).toBe('0x' + SPENDER_PADDED);
    expect(out.rawAmount).toBe('1000000');
    expect(out.formattedAmount).toBe('1.0');
  });

  test('returns null for unrelated calldata', () => {
    expect(decodeErc20Approve({ to: '0xUSDC', data: TRANSFER_DATA, chainId: 1 })).toBeNull();
  });
});

describe('decodeKnownAction', () => {
  test('routes transfer calldata through decodeErc20Transfer', () => {
    chainRegistry.getToken.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    const out = decodeKnownAction({ to: '0xUSDC', data: TRANSFER_DATA, chainId: 1 });
    expect(out.kind).toBe('erc20-transfer');
  });

  test('routes approve calldata through decodeErc20Approve', () => {
    chainRegistry.getToken.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    const out = decodeKnownAction({ to: '0xUSDC', data: APPROVE_DATA, chainId: 1 });
    expect(out.kind).toBe('erc20-approve');
  });

  test('returns null for unrecognised selectors and empty data', () => {
    expect(decodeKnownAction({ to: '0xWHATEVER', data: '0xdeadbeef', chainId: 1 })).toBeNull();
    expect(decodeKnownAction({ to: '0xWHATEVER', data: '0x', chainId: 1 })).toBeNull();
    expect(decodeKnownAction({ to: '0xWHATEVER', data: undefined, chainId: 1 })).toBeNull();
  });
});
