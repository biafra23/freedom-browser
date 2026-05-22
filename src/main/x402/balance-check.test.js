jest.mock('../logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const mockFetchTokenBalance = jest.fn();
jest.mock('../wallet/balance-service', () => ({
  fetchTokenBalance: (...args) => mockFetchTokenBalance(...args),
}));

const {
  INSUFFICIENT_BALANCE_MESSAGE,
  isInsufficientBalanceError,
  verifyBalanceOrThrow,
} = require('./balance-check');

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const baseAccept = {
  scheme: 'exact', network: 'eip155:8453', amount: '10000',
  asset: BASE_USDC,
};

// Mirrors wallet/balance-service.js's `{raw, formatted, symbol, decimals}`
// entry shape — keeps the mocks honest against any future shape
// regression in the production helper.
function balanceEntry(raw) {
  return { raw, formatted: '0', symbol: 'USDC', decimals: 6 };
}

beforeEach(() => {
  mockFetchTokenBalance.mockReset();
});

describe('isInsufficientBalanceError', () => {
  test('matches an error built from the canonical message', () => {
    expect(isInsufficientBalanceError(new Error(INSUFFICIENT_BALANCE_MESSAGE))).toBe(true);
  });
  test('rejects other errors', () => {
    expect(isInsufficientBalanceError(new Error('something else'))).toBe(false);
    expect(isInsufficientBalanceError(null)).toBe(false);
    expect(isInsufficientBalanceError(undefined)).toBe(false);
  });
});

describe('verifyBalanceOrThrow', () => {
  test('returns silently when the wallet has enough', async () => {
    mockFetchTokenBalance.mockResolvedValueOnce(balanceEntry('20000'));
    await expect(verifyBalanceOrThrow(baseAccept, ADDRESS)).resolves.toBeUndefined();
    expect(mockFetchTokenBalance).toHaveBeenCalledWith(ADDRESS, 8453, BASE_USDC);
  });

  test('throws INSUFFICIENT_BALANCE when the wallet is short', async () => {
    mockFetchTokenBalance.mockResolvedValueOnce(balanceEntry('9999'));
    await expect(verifyBalanceOrThrow(baseAccept, ADDRESS))
      .rejects.toThrow(INSUFFICIENT_BALANCE_MESSAGE);
  });

  test('treats exactly-equal balance as sufficient (BigInt >= boundary)', async () => {
    mockFetchTokenBalance.mockResolvedValueOnce(balanceEntry('10000'));
    await expect(verifyBalanceOrThrow(baseAccept, ADDRESS)).resolves.toBeUndefined();
  });

  test('degrades to a no-op when the active address is null (vault locked)', async () => {
    await expect(verifyBalanceOrThrow(baseAccept, null)).resolves.toBeUndefined();
    expect(mockFetchTokenBalance).not.toHaveBeenCalled();
  });

  test('degrades to a no-op for V1 string-network accepts (no CAIP-2 tuple)', async () => {
    const v1Accept = { network: 'base', maxAmountRequired: '10000', asset: BASE_USDC };
    await expect(verifyBalanceOrThrow(v1Accept, ADDRESS)).resolves.toBeUndefined();
    expect(mockFetchTokenBalance).not.toHaveBeenCalled();
  });

  test('degrades to a no-op when the RPC fetch fails (settlement is the next safety net)', async () => {
    mockFetchTokenBalance.mockRejectedValueOnce(new Error('RPC down'));
    await expect(verifyBalanceOrThrow(baseAccept, ADDRESS)).resolves.toBeUndefined();
  });

  test('degrades to a no-op when the returned entry lacks a raw field', async () => {
    mockFetchTokenBalance.mockResolvedValueOnce({ formatted: '1.0' });
    await expect(verifyBalanceOrThrow(baseAccept, ADDRESS)).resolves.toBeUndefined();
  });
});
