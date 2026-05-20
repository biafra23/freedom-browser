const path = require('path');
const fs = require('fs');
const os = require('os');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
}));

const { app } = require('electron');
const { append, getRecent, clearAll, _resetCache, MAX_RECEIPTS } = require('./receipts');

let tmpDir;

const sample = (overrides = {}) => ({
  url: 'https://api.example/article',
  origin: 'https://api.example',
  chainId: 8453,
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000',
  txHash: '0xabc',
  status: 'settled',
  settledAt: 1700000000,
  ...overrides,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-receipts-'));
  app.getPath.mockReturnValue(tmpDir);
  _resetCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// === append ===============================================================

describe('append', () => {
  test('persists a receipt and stamps a unique id', () => {
    const r = append(sample());
    expect(r).toMatchObject({
      url: 'https://api.example/article',
      origin: 'https://api.example',
      chainId: 8453,
      amount: '10000',
      txHash: '0xabc',
      status: 'settled',
      settledAt: 1700000000,
    });
    expect(r.id).toMatch(/^r-1700000000-\d+$/);
  });

  test('two receipts in the same second get distinct ids', () => {
    const a = append(sample({ settledAt: 1700000000 }));
    const b = append(sample({ settledAt: 1700000000 }));
    expect(a.id).not.toBe(b.id);
  });

  test('defaults txHash to null and status to no-receipt when absent', () => {
    const r = append({
      url: 'https://api.example/x',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '1',
      settledAt: 1700000000,
    });
    expect(r.txHash).toBeNull();
    expect(r.status).toBe('no-receipt');
  });

  test.each([
    ['missing url', { url: undefined }],
    ['missing origin', { origin: undefined }],
    ['non-numeric chainId', { chainId: 'eight' }],
    ['non-digit amount', { amount: '1.5' }],
    ['negative amount via minus sign', { amount: '-1' }],
  ])('rejects malformed input — %s', (_label, overrides) => {
    expect(() => append(sample(overrides))).toThrow();
  });
});

// === getRecent ============================================================

describe('getRecent', () => {
  test('returns newest-first', () => {
    append(sample({ settledAt: 1700000001 }));
    append(sample({ settledAt: 1700000002 }));
    append(sample({ settledAt: 1700000003 }));
    const recent = getRecent();
    expect(recent.map((r) => r.settledAt)).toEqual([1700000003, 1700000002, 1700000001]);
  });

  test('respects the limit', () => {
    for (let i = 0; i < 5; i++) {
      append(sample({ settledAt: 1700000000 + i }));
    }
    expect(getRecent(2).map((r) => r.settledAt)).toEqual([1700000004, 1700000003]);
  });
});

// === cap ==================================================================

describe('cap', () => {
  test('rolls off oldest entries past MAX_RECEIPTS', () => {
    // Smoke at boundary — we don't actually create 1000 entries in the
    // test, we trust the splice path. Verify the file stays bounded by
    // forcing the cap to take effect via direct push.
    for (let i = 0; i < MAX_RECEIPTS + 5; i++) {
      append(sample({ settledAt: 1_700_000_000 + i }));
    }
    const all = getRecent(MAX_RECEIPTS + 10);
    expect(all.length).toBeLessThanOrEqual(MAX_RECEIPTS);
    // The five earliest entries (i=0..4) should have been dropped.
    expect(all[all.length - 1].settledAt).toBe(1_700_000_000 + 5);
  });
});

// === persistence ==========================================================

describe('persistence', () => {
  test('survives a cache reset', () => {
    append(sample({ settledAt: 1700000001 }));
    _resetCache();
    expect(getRecent()).toHaveLength(1);
  });

  test('clearAll wipes the log', () => {
    append(sample());
    clearAll();
    expect(getRecent()).toEqual([]);
  });
});
