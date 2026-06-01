const mockIdentity = {
  isUnlocked: jest.fn(),
  exportPrivateKey: jest.fn(),
};
const mockResetVaultAutoLockTimer = jest.fn();

jest.mock('../identity-manager', () => ({
  loadIdentityModule: jest.fn(async () => mockIdentity),
}));
jest.mock('../vault-timer', () => ({
  resetVaultAutoLockTimer: mockResetVaultAutoLockTimer,
}));

const { withVaultPrivateKey } = require('./vault-access');

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

beforeEach(() => {
  // mockReset (vs mockClear) wipes the call list AND the impl — needed
  // because individual tests below flip isUnlocked / exportPrivateKey
  // mid-flight (locked-vault, throwing-callback) and we don't want one
  // test's tampering to leak into the next.
  mockIdentity.isUnlocked.mockReset().mockReturnValue(true);
  mockIdentity.exportPrivateKey.mockReset().mockReturnValue(TEST_KEY);
  mockResetVaultAutoLockTimer.mockClear();
});

describe('withVaultPrivateKey', () => {
  test('passes the exported key to the callback and returns its result', async () => {
    const result = await withVaultPrivateKey(0, (pk) => `signed:${pk}`);
    expect(result).toBe(`signed:${TEST_KEY}`);
    expect(mockIdentity.exportPrivateKey).toHaveBeenCalledWith(0);
  });

  test('awaits async callbacks', async () => {
    const result = await withVaultPrivateKey(0, async (pk) => {
      await Promise.resolve();
      return pk.length;
    });
    expect(result).toBe(TEST_KEY.length);
  });

  test('resets the auto-lock timer on success', async () => {
    await withVaultPrivateKey(0, () => undefined);
    expect(mockResetVaultAutoLockTimer).toHaveBeenCalledTimes(1);
  });

  test('throws "Vault is locked" when the vault is locked', async () => {
    mockIdentity.isUnlocked.mockReturnValue(false);
    await expect(withVaultPrivateKey(0, () => 'unreachable'))
      .rejects.toThrow('Vault is locked');
    expect(mockIdentity.exportPrivateKey).not.toHaveBeenCalled();
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalled();
  });

  test('does not reset the timer when the callback throws', async () => {
    // Preserves the existing per-handler invariant: only successful work
    // extends the auto-lock lease. Failed signs / failed sends shouldn't
    // keep an idle vault alive.
    await expect(withVaultPrivateKey(0, () => {
      throw new Error('signing failed');
    })).rejects.toThrow('signing failed');
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalled();
  });

  test('forwards the wallet index to exportPrivateKey', async () => {
    await withVaultPrivateKey(3, () => undefined);
    expect(mockIdentity.exportPrivateKey).toHaveBeenCalledWith(3);
  });

  test.each([
    ['negative', -1],
    ['non-integer', 1.5],
    ['string', '0'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
  ])('rejects %s walletIndex without touching the vault', async (_label, badIndex) => {
    await expect(withVaultPrivateKey(badIndex, () => 'unreachable'))
      .rejects.toThrow('Invalid wallet index');
    expect(mockIdentity.isUnlocked).not.toHaveBeenCalled();
    expect(mockIdentity.exportPrivateKey).not.toHaveBeenCalled();
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalled();
  });
});
