jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Capture every ipcMain.handle so the tests can drive handlers directly
// without going through Electron's IPC layer.
const ipcHandlers = {};
jest.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
  },
  webContents: {
    fromId: jest.fn(),
  },
}));

const mockClient = {
  createPaymentPayload: jest.fn(),
};
const mockCreateClient = jest.fn(async () => mockClient);
jest.mock('./client', () => ({
  createVaultBackedX402Client: (idx) => mockCreateClient(idx),
}));

const mockGetActiveWalletIndex = jest.fn(() => 0);
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => mockGetActiveWalletIndex(),
}));

// Real intercept module (real Maps) — we want to exercise the
// setPending/clearDetected interactions end-to-end. Stub electron's `app`
// because intercept requires it for getInterstitialFileUrl.
jest.mock('../webrequest-dispatcher', () => ({
  registerWebRequestHandler: jest.fn(),
}));

const mockGetToken = jest.fn();
jest.mock('../token-registry', () => ({
  getToken: (key) => mockGetToken(key),
  getTokenKey: (chainId, addr) => `${chainId}:${addr}`,
}));

const { webContents } = require('electron');
const intercept = require('./intercept');
const { outgoingHeaderForVersion } = require('./intercept');
const { registerX402Ipc } = require('./ipc');

beforeAll(() => {
  registerX402Ipc();
});

beforeEach(() => {
  intercept.clearAllDetectedPayments();
  intercept.clearAllPendingPayments();
  mockClient.createPaymentPayload.mockReset();
  mockCreateClient.mockReset().mockResolvedValue(mockClient);
  mockGetActiveWalletIndex.mockReturnValue(0);
  webContents.fromId.mockReset();
  mockGetToken.mockReset();
});

const v2Detected = (overrides = {}) => ({
  url: 'https://api.example/article',
  requirements: {
    x402Version: 2,
    resource: { url: 'https://api.example/article' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  },
  detectedAt: Date.now(),
  ...overrides,
});

const senderEvent = (id) => ({ sender: { id } });

// === outgoingHeaderForVersion ============================================

describe('outgoingHeaderForVersion', () => {
  test('V2 uses PAYMENT-SIGNATURE', () => {
    expect(outgoingHeaderForVersion(2)).toBe('PAYMENT-SIGNATURE');
  });
  test('V1 uses X-PAYMENT', () => {
    expect(outgoingHeaderForVersion(1)).toBe('X-PAYMENT');
  });
  test('unknown version defaults to V2 (newest)', () => {
    expect(outgoingHeaderForVersion(99)).toBe('PAYMENT-SIGNATURE');
  });
});

// === x402:get-details ====================================================

describe('x402:get-details', () => {
  test('returns the detected payment for the sender tab', async () => {
    intercept.detectedPaymentsForTest?.(); // no-op safety
    // Set up state via the public setter path that the real detector uses.
    const detected = v2Detected();
    // Push into the real Map by calling the detector — simpler than
    // reaching into internals. Skip and use the exposed clear/get APIs:
    // poke the Map directly through the module's internals.
    const internal = require('./intercept');
    // No public setter for detectedPayments; we instead call the real
    // detector path via the dispatcher handler so we exercise the same
    // entry point as production.
    internal.detectPaymentRequiredHandler({
      webContentsId: 42,
      url: detected.url,
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(detected.requirements)).toString('base64')],
      },
    });

    mockGetToken.mockReturnValueOnce({ symbol: 'USDC', decimals: 6 });

    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
    expect(result.success).toBe(true);
    expect(result.url).toBe(detected.url);
    expect(result.requirements.x402Version).toBe(2);
    expect(result.asset).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(mockGetToken).toHaveBeenCalledWith('8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });

  test('returns null asset when the token is not in the allowlist', async () => {
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    mockGetToken.mockReturnValueOnce(undefined);

    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
    expect(result.success).toBe(true);
    expect(result.asset).toBeNull();
  });

  test('returns an error when no payment was detected for the tab', async () => {
    const result = await ipcHandlers['x402:get-details'](senderEvent(999));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no pending/i);
  });
});

// === x402:approve ========================================================

describe('x402:approve', () => {
  const seedDetection = (tabId = 42) => {
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: tabId,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
  };

  test('signs, stashes a V2 pending payment, and re-navigates the webview', async () => {
    seedDetection(42);
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue({ loadURL });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await ipcHandlers['x402:approve'](senderEvent(42));

    expect(result.success).toBe(true);
    expect(mockCreateClient).toHaveBeenCalledWith(0);
    expect(loadURL).toHaveBeenCalledWith('https://api.example/article');

    // The pending payment is now armed for the retry; the inject handler
    // should attach PAYMENT-SIGNATURE on the matching outbound request.
    const injected = intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: { Accept: 'text/html' },
    });
    expect(injected?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();

    // The detected payment is cleared once we've signed it — preventing
    // a stale interstitial from re-using the requirements after the
    // re-navigation already kicked off.
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('surfaces a vault-locked error verbatim to the renderer', async () => {
    seedDetection(42);
    mockCreateClient.mockRejectedValueOnce(new Error('Vault is locked'));

    const result = await ipcHandlers['x402:approve'](senderEvent(42));
    expect(result.success).toBe(false);
    expect(result.error).toBe('Vault is locked');
    // No pending payment armed when signing failed.
    expect(intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: {},
    })).toBeNull();
  });

  test('refuses to sign if there is no detected payment for the tab', async () => {
    const result = await ipcHandlers['x402:approve'](senderEvent(42));
    expect(result.success).toBe(false);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

// === x402:cancel =========================================================

describe('x402:cancel', () => {
  test('clears the detection and steps back if history is available', async () => {
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    const goBack = jest.fn();
    webContents.fromId.mockReturnValue({
      canGoBack: () => true,
      goBack,
      loadURL: jest.fn(),
    });

    await ipcHandlers['x402:cancel'](senderEvent(42));

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('falls back to about:blank when no history is available', async () => {
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue({
      canGoBack: () => false,
      goBack: jest.fn(),
      loadURL,
    });

    await ipcHandlers['x402:cancel'](senderEvent(42));

    expect(loadURL).toHaveBeenCalledWith('about:blank');
  });

  test('no-ops if the webContents has already gone away', async () => {
    webContents.fromId.mockReturnValue(null);
    const result = await ipcHandlers['x402:cancel'](senderEvent(42));
    expect(result.success).toBe(true);
  });
});
