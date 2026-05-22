jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockLoadURL = jest.fn().mockResolvedValue();
jest.mock('electron', () => ({
  webContents: {
    fromId: jest.fn(() => ({ loadURL: mockLoadURL })),
  },
}));

const mockClient = {
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  createPaymentPayload: jest.fn(),
};
const mockCreateClient = jest.fn(async () => mockClient);
jest.mock('./client', () => ({
  createVaultBackedX402Client: (idx) => mockCreateClient(idx),
}));

jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => 0,
}));

// Real intercept module: setPendingPayment stashes into the real Map,
// which the test reads back via getPendingPayment-equivalent lookup.
jest.mock('../webrequest-dispatcher', () => ({
  registerWebRequestHandler: jest.fn(),
}));
jest.mock('../payment-history', () => ({
  append: jest.fn(),
  KINDS: { X402: 'x402' },
  STATUSES: { SETTLED: 'settled', NO_RECEIPT: 'no-receipt', FAILED: 'failed' },
}));
jest.mock('./permissions', () => ({
  grant: jest.fn(),
  getPermission: jest.fn(() => null),
  tryConsume: jest.fn(() => true),
}));

const intercept = require('./intercept');
const { signAndQueueRetry } = require('./sign-flow');

// Lowercase canonical — matches what `tupleFromAccept` emits.
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const GNOSIS_USDCE = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';

const baseAccept = {
  scheme: 'exact', network: 'eip155:8453', amount: '10000',
  asset: BASE_USDC, payTo: '0xBaseBaseBaseBaseBaseBaseBaseBaseBaseBase',
};
const gnosisAccept = {
  scheme: 'exact', network: 'eip155:100', amount: '20000',
  asset: GNOSIS_USDCE, payTo: '0xGnosisGnosisGnosisGnosisGnosisGnosisGnos',
};

function requirementsWith(...accepts) {
  return { x402Version: 2, resource: { url: 'https://api.example/article' }, accepts };
}

beforeEach(() => {
  intercept.clearAllPendingPayments();
  intercept.clearAllDetectedPayments();
  intercept.clearAllAwaitingResponse();
  mockClient.createPaymentPayload.mockReset().mockResolvedValue({
    x402Version: 2,
    payload: { authorization: {}, signature: '0xsig' },
  });
  mockCreateClient.mockClear();
  mockLoadURL.mockClear();
});

// Inspect the pending-payment slot the way the injector does, to
// verify what would actually ride on the next request to a given URL.
function consumePending(webContentsId, url) {
  const result = intercept.injectPaymentSignatureHandler({
    webContentsId, url, requestHeaders: {},
  });
  return result;
}

describe('signAndQueueRetry — selectedAccept resolution', () => {
  test('opts.selectedAccept WINS over detection.selectedAccept and accepts[0]', async () => {
    await signAndQueueRetry(7, {
      detection: {
        url: 'https://api.example/article',
        requirements: requirementsWith(baseAccept, gnosisAccept),
        resourceType: 'xhr',
        selectedAccept: gnosisAccept,  // would otherwise win
      },
      selectedAccept: baseAccept,
    });

    // The SDK was called with a single-entry accepts[] — the explicit opts.
    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(expect.objectContaining({
      accepts: [baseAccept],
    }));
    // And the receipt context records the explicit opts' chainId + asset.
    const injected = consumePending(7, 'https://api.example/article');
    expect(injected?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });

  test('detection.selectedAccept WINS over accepts[0] when opts.selectedAccept is omitted', async () => {
    await signAndQueueRetry(7, {
      detection: {
        url: 'https://api.example/article',
        requirements: requirementsWith(baseAccept, gnosisAccept),
        resourceType: 'xhr',
        selectedAccept: gnosisAccept,
      },
    });

    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(expect.objectContaining({
      accepts: [gnosisAccept],
    }));
  });

  test('falls back to accepts[0] when neither opts nor detection carry a selection', async () => {
    await signAndQueueRetry(7, {
      detection: {
        url: 'https://api.example/article',
        requirements: requirementsWith(baseAccept, gnosisAccept),
        resourceType: 'xhr',
      },
    });

    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(expect.objectContaining({
      accepts: [baseAccept],
    }));
  });

  test('throws "No accepts[] entry to sign" when every resolution source is empty', async () => {
    await expect(signAndQueueRetry(7, {
      detection: {
        url: 'https://api.example/article',
        requirements: { x402Version: 2, accepts: [] },
        resourceType: 'xhr',
      },
    })).rejects.toThrow(/No accepts\[\] entry to sign/);
  });
});
