const { Wallet, verifyTypedData } = require('ethers');

// Anvil/Hardhat-default test key — well-known, never funded on mainnet.
const TEST_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDRESS = new Wallet(TEST_PRIVATE_KEY).address;

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

const {
  buildVaultSigner,
  createVaultBackedX402Client,
  V1_NETWORKS,
} = require('./client');

beforeEach(() => {
  mockIdentity.isUnlocked.mockReturnValue(true);
  mockIdentity.exportPrivateKey.mockReturnValue(TEST_PRIVATE_KEY);
  mockResetVaultAutoLockTimer.mockClear();
});

// === buildVaultSigner ====================================================

describe('buildVaultSigner', () => {
  test('rejects when the vault is locked', async () => {
    mockIdentity.isUnlocked.mockReturnValue(false);
    await expect(buildVaultSigner(0)).rejects.toThrow(/locked/i);
  });

  test('exposes the address derived from the wallet index', async () => {
    const signer = await buildVaultSigner(0);
    expect(signer.address).toBe(TEST_ADDRESS);
    expect(mockIdentity.exportPrivateKey).toHaveBeenCalledWith(0);
  });

  test('signTypedData produces a signature recoverable to the wallet address', async () => {
    // Mirrors the EIP-3009 shape `@x402/evm`'s exact/eip3009 client emits —
    // the round-trip proves bigint values flow through ethers.signTypedData
    // without us needing a stringification shim.
    const signer = await buildVaultSigner(0);
    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    };
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };
    const message = {
      from: TEST_ADDRESS,
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: 10000n,
      validAfter: 1700000000n,
      validBefore: 1700000600n,
      nonce: '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480',
    };

    const sig = await signer.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(verifyTypedData(domain, types, message, sig)).toBe(TEST_ADDRESS);
    expect(mockResetVaultAutoLockTimer).toHaveBeenCalledTimes(1);
  });

  test('signTypedData throws if the vault re-locks between construction and signing', async () => {
    const signer = await buildVaultSigner(0);
    mockIdentity.isUnlocked.mockReturnValue(false);
    await expect(signer.signTypedData({ domain: {}, types: {}, primaryType: 'X', message: {} }))
      .rejects.toThrow(/locked/i);
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalled();
  });
});

// === createVaultBackedX402Client =========================================

describe('createVaultBackedX402Client', () => {
  test('returns an x402Client with V2 and V1 schemes wired', async () => {
    const client = await createVaultBackedX402Client(0);

    // selectPaymentRequirements returns the picked accepts[] entry; assert
    // on its scheme + network to prove the right scheme was matched, not
    // just any non-falsy value.
    const v2Pick = client.selectPaymentRequirements(2, [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        maxTimeoutSeconds: 60,
        resource: 'https://api.example/article',
        extra: { name: 'USD Coin', version: '2' },
      },
    ]);
    expect(v2Pick).toMatchObject({ scheme: 'exact', network: 'eip155:8453' });

    const v1Pick = client.selectPaymentRequirements(1, [
      {
        scheme: 'exact',
        network: 'base-sepolia',
        maxAmountRequired: '10000',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        maxTimeoutSeconds: 60,
        resource: 'https://api.example/article',
        extra: { name: 'USD Coin', version: '2' },
      },
    ]);
    expect(v1Pick).toMatchObject({ scheme: 'exact', network: 'base-sepolia' });
  });

  test('V1_NETWORKS covers Base / Base Sepolia / Ethereum', () => {
    // Asset-allowlist parity: a V1 server on any of these networks must
    // be reachable. Adding more is cheap; silently dropping one would
    // break paying customers on legacy endpoints.
    expect(V1_NETWORKS).toEqual(expect.arrayContaining(['base', 'base-sepolia', 'ethereum']));
  });

  test('produces a verifiable V2 payment payload end-to-end (Base / USDC)', async () => {
    const client = await createVaultBackedX402Client(0);

    // Shape of the parsed `PAYMENT-REQUIRED` header for a Base USDC 402.
    const paymentRequired = {
      x402Version: 2,
      resource: 'https://api.example/article',
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '10000',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          maxTimeoutSeconds: 60,
          resource: 'https://api.example/article',
          extra: { name: 'USD Coin', version: '2' },
        },
      ],
    };

    const result = await client.createPaymentPayload(paymentRequired);

    expect(result.x402Version).toBe(2);
    expect(result.payload.authorization).toMatchObject({
      from: TEST_ADDRESS,
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '10000',
    });
    expect(result.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);

    // Recover the signer from the EIP-3009 typed data — the asset
    // allowlist in WP3 will rely on this signature pointing back at the
    // user's wallet, not some other address the server tried to slip in.
    const { authorization, signature } = result.payload;
    const recovered = verifyTypedData(
      {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    );
    expect(recovered).toBe(TEST_ADDRESS);
  });
});
