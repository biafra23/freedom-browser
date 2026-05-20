jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockHostSend = jest.fn();
jest.mock('electron', () => ({
  webContents: {
    fromId: jest.fn(() => ({ hostWebContents: { send: mockHostSend } })),
  },
}));

const mockRegister = jest.fn();
jest.mock('../webrequest-dispatcher', () => ({
  registerWebRequestHandler: (...args) => mockRegister(...args),
}));

const mockAppendReceipt = jest.fn();
jest.mock('./receipts', () => ({
  append: (...args) => mockAppendReceipt(...args),
}));

// Auto-pay branch dispatches signAndQueueRetry via a lazy require —
// mock it so detector tests don't drag the whole sign flow in.
const mockSignAndQueueRetry = jest.fn();
jest.mock('./sign-flow', () => ({
  signAndQueueRetry: (...args) => mockSignAndQueueRetry(...args),
}));

const mockGetPermission = jest.fn(() => null);
jest.mock('./permissions', () => ({
  getPermission: (...args) => mockGetPermission(...args),
}));

const {
  X402_HEADERS,
  installX402Interception,
  detectPaymentRequiredHandler,
  injectPaymentSignatureHandler,
  paymentResponseLoggingHandler,
  parsePaymentRequiredHeader,
  setPendingPayment,
  getDetectedPayment,
  clearDetectedPayment,
  clearAllPendingPayments,
  clearAllDetectedPayments,
  cleanupWebContents,
} = require('./intercept');

beforeEach(() => {
  clearAllPendingPayments();
  clearAllDetectedPayments();
  mockRegister.mockClear();
  mockAppendReceipt.mockReset();
  mockHostSend.mockClear();
  mockSignAndQueueRetry.mockReset().mockResolvedValue(undefined);
  mockGetPermission.mockReset().mockReturnValue(null);
});

// Canonical Base USDC PaymentRequired (V2). `resource` is an object per
// @x402/core/schemas — see PaymentRequiredV2Schema in
// node_modules/@x402/core/dist/cjs/schemas/index.js. A plain-string
// resource is rejected by the schema even though the x402Client
// happens to accept it.
const sampleRequirements = {
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
      // No per-accepts `resource` in V2 — that's a V1 PaymentRequirements
      // field. V2's resource lives at the top level only.
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};
const sampleRequirementsB64 = Buffer.from(JSON.stringify(sampleRequirements)).toString('base64');

// Canonical V1 PaymentRequired — distinct field set (maxAmountRequired,
// description required, string-network, string-resource).
const sampleRequirementsV1 = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 60,
      resource: 'https://api.example/article',
      description: 'Premium article',
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};
const sampleRequirementsV1B64 = Buffer.from(JSON.stringify(sampleRequirementsV1)).toString('base64');

// === parsePaymentRequiredHeader ==========================================

describe('parsePaymentRequiredHeader', () => {
  test('round-trips valid base64-encoded JSON', () => {
    const result = parsePaymentRequiredHeader(sampleRequirementsB64);
    expect(result).toEqual(sampleRequirements);
  });

  test.each([
    ['empty string', ''],
    ['null', null],
    ['non-string', 42],
    ['base64 of non-JSON', Buffer.from('not json').toString('base64')],
    ['base64 of JSON without x402Version', Buffer.from('{"accepts":[]}').toString('base64')],
    ['base64 of JSON with empty accepts', Buffer.from('{"x402Version":2,"accepts":[]}').toString('base64')],
    ['base64 of JSON with plain-string resource (V2 requires object)', Buffer.from(JSON.stringify({
      x402Version: 2, resource: 'plain-string', accepts: sampleRequirements.accepts,
    })).toString('base64')],
  ])('returns null for %s', (_label, input) => {
    expect(parsePaymentRequiredHeader(input)).toBeNull();
  });
});

// === detectPaymentRequiredHandler ========================================

describe('detectPaymentRequiredHandler', () => {
  const detail = (overrides = {}) => ({
    webContentsId: 7,
    url: 'https://api.example/article',
    statusLine: 'HTTP/1.1 402 Payment Required',
    responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    ...overrides,
  });

  test('on 402 with V2 header: stashes the payment and fires the approval event at the host', () => {
    const result = detectPaymentRequiredHandler(detail());

    // Pass-through — the host renderer's sidebar handles the approval
    // UI; the webview's response renders whatever the server sent.
    expect(result).toBeNull();
    expect(getDetectedPayment(7)).toMatchObject({
      url: 'https://api.example/article',
      requirements: sampleRequirements,
    });
    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-needed', expect.objectContaining({
      webContentsId: 7,
      url: 'https://api.example/article',
    }));
  });

  test('auto-pay: when an active cap covers the charge, calls signAndQueueRetry and skips the host event', () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    // Use real timers so the setImmediate inside the auto-pay branch
    // actually fires.
    detectPaymentRequiredHandler(detail());
    return new Promise((resolve) => setImmediate(() => {
      expect(mockSignAndQueueRetry).toHaveBeenCalledWith(7);
      expect(mockHostSend).not.toHaveBeenCalled();
      resolve();
    }));
  });

  test('accepts a V1 PaymentRequired payload from X-PAYMENT-REQUIRED', () => {
    detectPaymentRequiredHandler(detail({
      responseHeaders: { 'X-PAYMENT-REQUIRED': [sampleRequirementsV1B64] },
    }));
    expect(getDetectedPayment(7)?.requirements.x402Version).toBe(1);
  });

  test('header lookup is case-insensitive (servers vary on casing)', () => {
    detectPaymentRequiredHandler(detail({
      responseHeaders: { 'payment-required': [sampleRequirementsB64] },
    }));
    expect(getDetectedPayment(7)).not.toBeNull();
  });

  test('ignores non-402 responses even with PAYMENT-REQUIRED header', () => {
    detectPaymentRequiredHandler(detail({
      statusLine: 'HTTP/1.1 200 OK',
    }));
    expect(getDetectedPayment(7)).toBeNull();
  });

  test('ignores 402 with no payment header (body-only V1 servers fall through here)', () => {
    detectPaymentRequiredHandler(detail({ responseHeaders: {} }));
    expect(getDetectedPayment(7)).toBeNull();
  });

  test('ignores 402 with an unparseable payment header', () => {
    detectPaymentRequiredHandler(detail({
      responseHeaders: { 'PAYMENT-REQUIRED': ['!!not base64!!'] },
    }));
    expect(getDetectedPayment(7)).toBeNull();
  });

  test('separates detections by webContentsId (different tabs)', () => {
    detectPaymentRequiredHandler(detail({ webContentsId: 7 }));
    detectPaymentRequiredHandler(detail({
      webContentsId: 8,
      url: 'https://other.example/page',
    }));

    expect(getDetectedPayment(7)?.url).toBe('https://api.example/article');
    expect(getDetectedPayment(8)?.url).toBe('https://other.example/page');
  });

  test('a fresh detection on the same tab replaces the prior one', () => {
    detectPaymentRequiredHandler(detail({ url: 'https://api.example/article-1' }));
    detectPaymentRequiredHandler(detail({ url: 'https://api.example/article-2' }));
    expect(getDetectedPayment(7)?.url).toBe('https://api.example/article-2');
  });

  test('clearDetectedPayment wipes a single tab', () => {
    detectPaymentRequiredHandler(detail());
    clearDetectedPayment(7);
    expect(getDetectedPayment(7)).toBeNull();
  });
});

// === setPendingPayment validation ========================================

describe('setPendingPayment input validation', () => {
  test('throws on an unrecognised header name (catches WP4 typos)', () => {
    expect(() => setPendingPayment(7, 'https://x.example/', {
      header: 'PAYMENT-SIGNAURE', // typo
      value: 'eyJ...',
    })).toThrow(/invalid pending-payment header/);
  });

  test('throws on null/undefined value', () => {
    expect(() => setPendingPayment(7, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: '',
    })).toThrow(/non-empty string/);
  });

  test('accepts the two canonical signature header names', () => {
    expect(() => setPendingPayment(7, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'eyJ...',
    })).not.toThrow();
    expect(() => setPendingPayment(7, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V1,
      value: 'eyJ...',
    })).not.toThrow();
  });
});

// === injectPaymentSignatureHandler =======================================

describe('injectPaymentSignatureHandler', () => {
  const detail = (overrides = {}) => ({
    webContentsId: 7,
    url: 'https://api.example/article',
    requestHeaders: { Accept: 'text/html' },
    ...overrides,
  });

  test('attaches PAYMENT-SIGNATURE when a V2 pending payment exists', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'eyJwYXlsb2FkIjp7fX0=',
    });

    const result = injectPaymentSignatureHandler(detail());
    expect(result).toEqual({
      requestHeaders: {
        Accept: 'text/html',
        'PAYMENT-SIGNATURE': 'eyJwYXlsb2FkIjp7fX0=',
      },
    });
  });

  test('attaches X-PAYMENT when the pending entry is a V1 payload', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V1,
      value: 'eyJwYXlsb2FkIjp7fX0=',
    });
    const result = injectPaymentSignatureHandler(detail());
    expect(result.requestHeaders['X-PAYMENT']).toBeDefined();
    expect(result.requestHeaders['PAYMENT-SIGNATURE']).toBeUndefined();
  });

  test('one-shot: a second request to the same URL gets no injection', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
    });
    expect(injectPaymentSignatureHandler(detail())).not.toBeNull();
    expect(injectPaymentSignatureHandler(detail())).toBeNull();
  });

  test('passes through when there is no pending payment', () => {
    expect(injectPaymentSignatureHandler(detail())).toBeNull();
  });

  test('only fires for the exact (webContentsId, url) pair', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
    });

    // Wrong tab — pass through.
    expect(injectPaymentSignatureHandler(detail({ webContentsId: 9 }))).toBeNull();
    // Wrong URL — pass through.
    expect(injectPaymentSignatureHandler(detail({
      url: 'https://api.example/different',
    }))).toBeNull();
    // The original pending payment must still be there, not consumed.
    expect(injectPaymentSignatureHandler(detail())).not.toBeNull();
  });
});

// === cleanupWebContents ==================================================

describe('cleanupWebContents', () => {
  test('drops detected payment for the closed tab and leaves other tabs', () => {
    detectPaymentRequiredHandler({
      webContentsId: 7,
      url: 'https://a.example/',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    detectPaymentRequiredHandler({
      webContentsId: 8,
      url: 'https://b.example/',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });

    cleanupWebContents(7);

    expect(getDetectedPayment(7)).toBeNull();
    expect(getDetectedPayment(8)).not.toBeNull();
  });

  test('drops only the closed tab\'s pending payments (not the URL on other tabs)', () => {
    setPendingPayment(7, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-7',
    });
    setPendingPayment(8, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-8',
    });

    cleanupWebContents(7);

    expect(injectPaymentSignatureHandler({
      webContentsId: 7,
      url: 'https://x.example/',
      requestHeaders: {},
    })).toBeNull();
    expect(injectPaymentSignatureHandler({
      webContentsId: 8,
      url: 'https://x.example/',
      requestHeaders: {},
    })).not.toBeNull();
  });
});

// === isStatus402 edge cases (via detector) ===============================

describe('isStatus402 edge cases (via detector pass-through)', () => {
  // Drive through the detector to avoid exporting the inner helper just
  // for tests — the behaviour we care about is "non-402 status lines
  // never trigger a detection."
  const driveWith = (statusLine) => {
    detectPaymentRequiredHandler({
      webContentsId: 7,
      url: 'https://x.example/',
      statusLine,
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    return getDetectedPayment(7);
  };

  test.each([
    ['undefined statusLine', undefined],
    ['null statusLine', null],
    ['number statusLine', 42],
    ['empty string', ''],
    ['HTTP/2 402 (no period in protocol)', 'HTTP/2 402 Payment Required'],
  ])('%s', (label, statusLine) => {
    const result = driveWith(statusLine);
    // The first four should NOT detect; HTTP/2 SHOULD (it contains ' 402 ').
    if (label.startsWith('HTTP/2')) {
      expect(result).not.toBeNull();
    } else {
      expect(result).toBeNull();
    }
  });

  test('a 4022 status line (no padded boundary) is not a 402', () => {
    expect(driveWith('HTTP/1.1 4022 Something')).toBeNull();
  });
});

// === installX402Interception =============================================

describe('installX402Interception', () => {
  test('registers detect+receipt on onHeadersReceived and inject on onBeforeSendHeaders', () => {
    installX402Interception();

    expect(mockRegister).toHaveBeenCalledTimes(3);
    expect(mockRegister).toHaveBeenCalledWith(
      'onHeadersReceived',
      'x402-detect',
      detectPaymentRequiredHandler
    );
    expect(mockRegister).toHaveBeenCalledWith(
      'onHeadersReceived',
      'x402-receipt',
      paymentResponseLoggingHandler
    );
    expect(mockRegister).toHaveBeenCalledWith(
      'onBeforeSendHeaders',
      'x402-inject',
      injectPaymentSignatureHandler
    );
  });
});

describe('paymentResponseLoggingHandler', () => {
  const responseB64 = Buffer.from(JSON.stringify({ txHash: '0xabc', success: true })).toString('base64');

  test('short-circuits without iterating headers when no injection is awaiting', () => {
    // Set a header that would otherwise be picked up. The handler must
    // not touch responseHeaders unless armed via injectPaymentSignatureHandler.
    const responseHeaders = {
      get [Symbol.iterator]() {
        throw new Error('paymentResponseLoggingHandler must not iterate headers on the miss path');
      },
    };
    const result = paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      responseHeaders,
    });
    expect(result).toBeNull();
  });

  const armInjection = (overrides = {}) => {
    setPendingPayment(7, 'https://api.example/article', {
      header: 'PAYMENT-SIGNATURE',
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
      ...overrides,
    });
    injectPaymentSignatureHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
  };

  test('on a 200 + PAYMENT-RESPONSE: writes a settled receipt with txHash', () => {
    armInjection();
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).toHaveBeenCalledTimes(1);
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.example/article',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
      txHash: '0xabc',
      status: 'settled',
    }));
  });

  test('on a 200 with no PAYMENT-RESPONSE: writes a no-receipt entry (user signed, server confirmed nothing)', () => {
    armInjection();
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: {},
    });
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({
      txHash: null,
      status: 'no-receipt',
    }));
  });

  test('on a non-2xx: writes a failed receipt so the user can see they signed but got nothing', () => {
    armInjection();
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 500 Internal Server Error',
      responseHeaders: {},
    });
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      txHash: null,
    }));
  });

  test('one-shot: a second response to the same URL does not write a duplicate', () => {
    armInjection();
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).toHaveBeenCalledTimes(1);
  });

  test('no injection awaiting: no receipt is written and headers are not touched', () => {
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).not.toHaveBeenCalled();
  });
});
