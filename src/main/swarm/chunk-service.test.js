var mockMakeContentAddressedChunk = jest.fn();
var mockUploadChunk = jest.fn();
var mockDownloadChunk = jest.fn();
var mockUnmarshalContentAddressedChunk = jest.fn();
var mockUnmarshalSingleOwnerChunk = jest.fn();
var mockCalculateSingleOwnerChunkAddress = jest.fn();
var mockSelectBestBatch = jest.fn();

class MockBeeResponseError extends Error {
  constructor(status, message = 'Bee response error') {
    super(message);
    this.status = status;
  }
}

class MockHexValue {
  constructor(hex) { this._hex = hex; }
  toHex() { return this._hex; }
  toUint8Array() { return Buffer.from(this._hex, 'hex'); }
}

class MockSpan {
  constructor(value) { this._value = BigInt(value); }
  toBigInt() { return this._value; }
}

class MockPayload {
  constructor(bytes) { this._bytes = Buffer.from(bytes); }
  toUint8Array() { return this._bytes; }
}

class MockOwner extends MockHexValue {
  toChecksum() { return `0x${this._hex}`; }
}

class MockPublicKey {
  constructor(owner) { this._owner = owner; }
  address() { return this._owner; }
}

class MockPrivateKey {
  constructor(hex) {
    this._hex = hex;
    this._owner = new MockOwner(hex.replace(/^0x/, '').slice(0, 40));
  }
  publicKey() { return new MockPublicKey(this._owner); }
}

class MockIdentifier {
  constructor(hex) { this._hex = hex; }
  toUint8Array() { return Buffer.from(this._hex, 'hex'); }
}

class MockEthAddress {
  constructor(hex) { this._hex = hex.replace(/^0x/, ''); }
  toUint8Array() { return Buffer.from(this._hex, 'hex'); }
}

var mockBee = {
  makeContentAddressedChunk: mockMakeContentAddressedChunk,
  uploadChunk: mockUploadChunk,
  downloadChunk: mockDownloadChunk,
  unmarshalContentAddressedChunk: mockUnmarshalContentAddressedChunk,
  unmarshalSingleOwnerChunk: mockUnmarshalSingleOwnerChunk,
  calculateSingleOwnerChunkAddress: mockCalculateSingleOwnerChunkAddress,
};

jest.mock('@ethersphere/bee-js', () => ({
  PrivateKey: MockPrivateKey,
  BeeResponseError: MockBeeResponseError,
  Identifier: MockIdentifier,
  EthAddress: MockEthAddress,
}));

jest.mock('./swarm-service', () => ({
  getBee: () => mockBee,
  selectBestBatch: mockSelectBestBatch,
  toHex: (value) => value?.toHex?.() || String(value || ''),
}));

const {
  publishChunk,
  readChunk,
  writeSingleOwnerChunk,
  readSingleOwnerChunk,
  getSignerAddress,
  spanToResult,
  isChunkNotFoundError,
} = require('./chunk-service');

const BATCH_ID = 'aa'.repeat(32);
const CAC_REFERENCE = 'bb'.repeat(32);
const SOC_REFERENCE = 'cc'.repeat(32);
const IDENTIFIER = 'dd'.repeat(32);
const SIGNATURE = 'ee'.repeat(65);
const OWNER = '11'.repeat(20);
const PRIVATE_KEY = `0x${OWNER}${'22'.repeat(12)}`;

function makeCac(payload = 'hello', span = 5n, reference = CAC_REFERENCE) {
  return {
    data: Buffer.concat([Buffer.alloc(8), Buffer.from(payload)]),
    span: new MockSpan(span),
    payload: new MockPayload(payload),
    address: new MockHexValue(reference),
    toSingleOwnerChunk: jest.fn((identifier, signer) => ({
      data: Buffer.concat([Buffer.from(identifier, 'hex'), Buffer.alloc(65), Buffer.alloc(8), Buffer.from(payload)]),
      span: new MockSpan(span),
      payload: new MockPayload(payload),
      address: new MockHexValue(SOC_REFERENCE),
      owner: signer.publicKey().address(),
      identifier: new MockHexValue(identifier),
      signature: new MockHexValue(SIGNATURE),
    })),
  };
}

function makeSoc(payload = 'hello', span = 5n) {
  return {
    data: Buffer.from(payload),
    span: new MockSpan(span),
    payload: new MockPayload(payload),
    address: new MockHexValue(SOC_REFERENCE),
    owner: new MockOwner(OWNER),
    identifier: new MockHexValue(IDENTIFIER),
    signature: new MockHexValue(SIGNATURE),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectBestBatch.mockResolvedValue(BATCH_ID);
  mockUploadChunk.mockResolvedValue({ reference: new MockHexValue(CAC_REFERENCE) });
  mockCalculateSingleOwnerChunkAddress.mockReturnValue(new MockHexValue(SOC_REFERENCE));
});

describe('chunk-service', () => {
  test('spanToResult returns number for safe spans and bigint for large spans', () => {
    expect(spanToResult(new MockSpan(10n))).toBe(10);
    expect(spanToResult(new MockSpan(BigInt(Number.MAX_SAFE_INTEGER) + 1n)))
      .toBe(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  });

  test('isChunkNotFoundError only matches Bee 404s', () => {
    expect(isChunkNotFoundError(new MockBeeResponseError(404))).toBe(true);
    expect(isChunkNotFoundError(new MockBeeResponseError(500))).toBe(false);
    expect(isChunkNotFoundError(new Error('network'))).toBe(false);
  });

  test('getSignerAddress returns the signer owner', () => {
    expect(getSignerAddress(PRIVATE_KEY)).toBe(`0x${OWNER}`);
  });

  test('publishChunk uploads a CAC and returns its address', async () => {
    const cac = makeCac();
    mockMakeContentAddressedChunk.mockReturnValue(cac);

    const result = await publishChunk(Buffer.from('hello'), { span: 5n });

    expect(mockMakeContentAddressedChunk).toHaveBeenCalledWith(Buffer.from('hello'), 5n);
    expect(mockSelectBestBatch).toHaveBeenCalledWith(4096);
    expect(mockUploadChunk).toHaveBeenCalledWith(BATCH_ID, cac, { pin: true, deferred: false });
    expect(result).toEqual({ reference: CAC_REFERENCE, batchIdUsed: BATCH_ID });
  });

  test('publishChunk fails when no batch is available', async () => {
    mockMakeContentAddressedChunk.mockReturnValue(makeCac());
    mockSelectBestBatch.mockResolvedValue(null);

    await expect(publishChunk(Buffer.from('hello'))).rejects.toThrow('No usable postage batch');
  });

  test('readChunk returns base64 payload and span after CAC validation', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalContentAddressedChunk.mockReturnValue(makeCac('hello', 5n, CAC_REFERENCE));

    const result = await readChunk(CAC_REFERENCE);

    expect(mockDownloadChunk).toHaveBeenCalledWith(CAC_REFERENCE);
    expect(result).toEqual({
      data: Buffer.from('hello').toString('base64'),
      encoding: 'base64',
      span: 5,
    });
  });

  test('readChunk maps a mismatched address to chunk_type_mismatch', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalContentAddressedChunk.mockReturnValue(makeCac('hello', 5n, 'ff'.repeat(32)));

    await expect(readChunk(CAC_REFERENCE)).rejects.toMatchObject({
      reason: 'chunk_type_mismatch',
    });
  });

  test('readChunk maps Bee 404 to chunk_not_found', async () => {
    mockDownloadChunk.mockRejectedValue(new MockBeeResponseError(404));

    await expect(readChunk(CAC_REFERENCE)).rejects.toMatchObject({
      reason: 'chunk_not_found',
    });
  });

  test('writeSingleOwnerChunk signs and uploads an SOC', async () => {
    const cac = makeCac();
    mockMakeContentAddressedChunk.mockReturnValue(cac);

    const result = await writeSingleOwnerChunk(PRIVATE_KEY, IDENTIFIER, Buffer.from('hello'), { span: 5n });

    expect(cac.toSingleOwnerChunk).toHaveBeenCalledWith(IDENTIFIER, expect.any(MockPrivateKey));
    expect(mockUploadChunk).toHaveBeenCalledWith(BATCH_ID, expect.objectContaining({
      address: expect.any(MockHexValue),
    }), { pin: true, deferred: false });
    expect(result).toEqual({
      reference: SOC_REFERENCE,
      owner: `0x${OWNER}`,
      identifier: IDENTIFIER,
      batchIdUsed: BATCH_ID,
    });
  });

  test('readSingleOwnerChunk supports address reads', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalSingleOwnerChunk.mockReturnValue(makeSoc());

    const result = await readSingleOwnerChunk({ address: SOC_REFERENCE });

    expect(mockDownloadChunk).toHaveBeenCalledWith(SOC_REFERENCE);
    expect(mockUnmarshalSingleOwnerChunk).toHaveBeenCalledWith(Buffer.from('raw'), SOC_REFERENCE);
    expect(result).toEqual(expect.objectContaining({
      data: Buffer.from('hello').toString('base64'),
      encoding: 'base64',
      reference: SOC_REFERENCE,
      owner: `0x${OWNER}`,
      identifier: IDENTIFIER,
      signature: SIGNATURE,
    }));
  });

  test('readSingleOwnerChunk supports owner plus identifier reads', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalSingleOwnerChunk.mockReturnValue(makeSoc());

    const result = await readSingleOwnerChunk({ owner: `0x${OWNER}`, identifier: IDENTIFIER });

    expect(mockCalculateSingleOwnerChunkAddress).toHaveBeenCalledWith(
      expect.any(MockIdentifier),
      expect.any(MockEthAddress)
    );
    expect(mockDownloadChunk).toHaveBeenCalledWith(SOC_REFERENCE);
    expect(result.reference).toBe(SOC_REFERENCE);
  });
});
