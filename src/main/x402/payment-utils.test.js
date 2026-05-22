const mockGetPermission = jest.fn();
jest.mock('./permissions', () => ({
  getPermission: (...args) => mockGetPermission(...args),
}));

const {
  tupleFromAccept,
  findCoveringPermission,
  paymentTuple,
  getPermissionCoverage,
} = require('./payment-utils');

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const GNOSIS_USDCE = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';

beforeEach(() => {
  mockGetPermission.mockReset().mockReturnValue(null);
});

// === tupleFromAccept =====================================================

describe('tupleFromAccept', () => {
  test('extracts (chainId, asset, amount) from a V2 entry', () => {
    expect(tupleFromAccept({
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: BASE_USDC,
    })).toEqual({ chainId: 8453, asset: BASE_USDC, amount: '10000' });
  });

  test('returns null for V1 string networks (we only auto-pay CAIP-2)', () => {
    // V1 uses bare network names like 'base'; our cap store is keyed
    // by chainId so we can't look up. Sign-path still works for V1 via
    // a different selection, but the auto-pay tuple is null.
    expect(tupleFromAccept({ network: 'base', maxAmountRequired: '10000', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: 'ethereum', maxAmountRequired: '10000', asset: '0x' })).toBeNull();
  });

  test('returns null for missing or malformed network', () => {
    expect(tupleFromAccept({ amount: '10000', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: '', amount: '10000', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: 42, amount: '10000', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: 'eip155:notanumber', amount: '10000', asset: BASE_USDC })).toBeNull();
  });

  test('returns null when amount is missing or non-string (zod-parsed V2 always has it; defense vs unparsed input)', () => {
    expect(tupleFromAccept({ network: 'eip155:8453', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: 'eip155:8453', amount: 10000, asset: BASE_USDC })).toBeNull();
  });

  test('returns null for null/undefined input (defensive)', () => {
    expect(tupleFromAccept(null)).toBeNull();
    expect(tupleFromAccept(undefined)).toBeNull();
  });
});

// === findCoveringPermission ==============================================

describe('findCoveringPermission', () => {
  const baseAccept = {
    scheme: 'exact', network: 'eip155:8453', amount: '10000',
    asset: BASE_USDC, payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  };
  const gnosisAccept = {
    scheme: 'exact', network: 'eip155:100', amount: '20000',
    asset: GNOSIS_USDCE, payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  };
  const ORIGIN = 'https://api.example';

  function permFor(capAmount, spentAmount = '0') {
    return { capAmount, spentAmount, createdAt: 1, expiresAt: 9999999999 };
  }

  test('returns the first accepts[] entry whose cap covers (server order respected)', () => {
    // Both entries have caps; both cover. Server order wins.
    mockGetPermission.mockImplementation((origin, chainId) => {
      if (chainId === 8453) return permFor('100000');
      if (chainId === 100) return permFor('100000');
      return null;
    });

    const result = findCoveringPermission(ORIGIN, [baseAccept, gnosisAccept]);
    expect(result?.accept).toBe(baseAccept);
    expect(result?.tuple).toEqual({ chainId: 8453, asset: BASE_USDC, amount: '10000' });
    expect(result?.remaining).toBe(100000n);
  });

  test('skips an accept whose cap exists but is under-funded; picks the next covered entry', () => {
    // Base cap exhausted; Gnosis cap covers. Multi-accept lets us use Gnosis instead.
    mockGetPermission.mockImplementation((origin, chainId) => {
      if (chainId === 8453) return permFor('10000', '10000');  // 0 remaining
      if (chainId === 100) return permFor('100000');
      return null;
    });

    const result = findCoveringPermission(ORIGIN, [baseAccept, gnosisAccept]);
    expect(result?.accept).toBe(gnosisAccept);
    expect(result?.tuple.chainId).toBe(100);
  });

  test('skips an accept with no registered cap; picks the next covered entry', () => {
    mockGetPermission.mockImplementation((origin, chainId) => {
      if (chainId === 8453) return null;          // no Base cap
      if (chainId === 100) return permFor('100000');
      return null;
    });

    const result = findCoveringPermission(ORIGIN, [baseAccept, gnosisAccept]);
    expect(result?.accept).toBe(gnosisAccept);
  });

  test('keys on (chainId, asset): a cap on the right chain but wrong asset does NOT match', () => {
    // Cap exists for chain 8453 but only for USDT, not Base USDC.
    // findCoveringPermission must pass tuple.asset into getPermission;
    // a cap on a different asset of the same chain is not a match.
    const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';
    mockGetPermission.mockImplementation((origin, chainId, asset) => {
      if (chainId === 8453 && asset === USDT_BASE) return permFor('100000');
      return null;
    });
    expect(findCoveringPermission(ORIGIN, [baseAccept])).toBeNull();
    expect(mockGetPermission).toHaveBeenCalledWith(ORIGIN, 8453, BASE_USDC);
  });

  test('returns null when no accepts[] entry has a covering cap', () => {
    mockGetPermission.mockReturnValue(null);
    expect(findCoveringPermission(ORIGIN, [baseAccept, gnosisAccept])).toBeNull();
  });

  test('returns null when every accepts[] entry is non-EIP-155 (V1 string networks)', () => {
    const result = findCoveringPermission(ORIGIN, [
      { scheme: 'exact', network: 'base', maxAmountRequired: '10000', asset: BASE_USDC },
      { scheme: 'exact', network: 'ethereum', maxAmountRequired: '10000', asset: '0xeth' },
    ]);
    expect(result).toBeNull();
    // getPermission was never consulted — the tuple short-circuits before it.
    expect(mockGetPermission).not.toHaveBeenCalled();
  });

  test('returns null for empty or missing accepts', () => {
    expect(findCoveringPermission(ORIGIN, [])).toBeNull();
    expect(findCoveringPermission(ORIGIN, undefined)).toBeNull();
    expect(findCoveringPermission(ORIGIN, null)).toBeNull();
  });

  test('treats EXACTLY-equal headroom as covering (BigInt <= boundary)', () => {
    mockGetPermission.mockReturnValueOnce(permFor('10000', '0'));  // 10000 remaining == 10000 amount
    const result = findCoveringPermission(ORIGIN, [baseAccept]);
    expect(result?.accept).toBe(baseAccept);
    expect(result?.remaining).toBe(10000n);
  });

  test('treats one-under headroom as NOT covering', () => {
    mockGetPermission.mockReturnValueOnce(permFor('9999', '0'));   // 9999 remaining < 10000 amount
    expect(findCoveringPermission(ORIGIN, [baseAccept])).toBeNull();
  });
});

// === paymentTuple compat shim ============================================

describe('paymentTuple (compat shim)', () => {
  test('returns the tuple of accepts[0] when present', () => {
    expect(paymentTuple({
      accepts: [
        { network: 'eip155:8453', amount: '10000', asset: BASE_USDC },
        { network: 'eip155:100', amount: '20000', asset: GNOSIS_USDCE },
      ],
    })).toEqual({ chainId: 8453, asset: BASE_USDC, amount: '10000' });
  });

  test('returns null for empty / missing accepts', () => {
    expect(paymentTuple({ accepts: [] })).toBeNull();
    expect(paymentTuple({})).toBeNull();
    expect(paymentTuple(null)).toBeNull();
    expect(paymentTuple(undefined)).toBeNull();
  });
});

// === getPermissionCoverage compat shim ===================================

describe('getPermissionCoverage (compat shim)', () => {
  const requirements = {
    accepts: [{ network: 'eip155:8453', amount: '10000', asset: BASE_USDC }],
  };

  test('reports covers:true when accepts[0] cap covers', () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0', createdAt: 1, expiresAt: 9999999999,
    });
    const result = getPermissionCoverage('https://api.example/article', requirements);
    expect(result?.covers).toBe(true);
    expect(result?.remaining).toBe(20000n);
  });

  test('reports covers:false when remaining is less than amount', () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '10000', spentAmount: '5000', createdAt: 1, expiresAt: 9999999999,
    });
    const result = getPermissionCoverage('https://api.example/article', requirements);
    expect(result?.covers).toBe(false);
    expect(result?.remaining).toBe(5000n);
  });

  test('returns null on a non-parsable URL', () => {
    expect(getPermissionCoverage('not a url', requirements)).toBeNull();
  });

  test('returns null when no permission exists (default mock)', () => {
    expect(getPermissionCoverage('https://api.example/article', requirements)).toBeNull();
  });
});
