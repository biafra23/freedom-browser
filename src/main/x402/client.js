/**
 * x402 vault-backed payment client.
 *
 * Wires `@x402/core`'s `x402Client` to the freedom-browser vault so payment
 * authorizations get signed inside the existing wallet — no raw keys leave
 * the main process, and the same auto-lock UX that protects dApp signing
 * protects x402 payments.
 *
 * Higher layers (the navigation interceptor / interstitial in WP3) call
 * `createVaultBackedX402Client(walletIndex)` after the user has approved a
 * payment, then drive the returned client to produce the `PAYMENT-SIGNATURE`
 * header value.
 */

const { x402Client } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { ExactEvmSchemeV1 } = require('@x402/evm/exact/v1/client');
const { Wallet } = require('ethers');

const { withVaultPrivateKey } = require('../wallet/vault-access');
const { signTypedData: signTypedDataWithKey } = require('../wallet/transaction-service');

// V1 servers use string network names (not CAIP-2); unknown ones fall
// through to whichever V2 `accepts[]` entry the server also exposed.
const V1_NETWORKS = ['base', 'base-sepolia', 'ethereum'];

/**
 * Build a vault-backed `ClientEvmSigner` for the given wallet index.
 *
 * The returned signer matches `@x402/evm`'s `ClientEvmSigner` shape — just
 * `address` + `signTypedData`. No `readContract` etc., so EIP-2612 / ERC-20-
 * approval extensions aren't supported on this signer; the base USDC /
 * EIP-3009 flow doesn't need them.
 *
 * @param {number} walletIndex
 * @returns {Promise<{ address: string, signTypedData: (msg: object) => Promise<string> }>}
 */
async function buildVaultSigner(walletIndex) {
  // Resolve the address once at construction. withVaultPrivateKey also
  // resets the auto-lock timer, so the typical "build then immediately
  // sign" flow doesn't race the timeout. Each subsequent signTypedData
  // call re-runs the same unlock check in case the vault re-locked.
  const address = await withVaultPrivateKey(walletIndex, (privateKey) =>
    new Wallet(privateKey).address
  );

  return {
    address,
    signTypedData: (msg) =>
      withVaultPrivateKey(walletIndex, (privateKey) =>
        signTypedDataWithKey(msg, privateKey)
      ),
  };
}

/**
 * Construct an `x402Client` whose signing flows through the vault.
 *
 * Both V2 (CAIP-2, registered with the `eip155:*` glob) and V1 (legacy
 * string network names) schemes are wired so the client can produce
 * payment payloads against either flavour of x402 server.
 *
 * @param {number} [walletIndex=0]
 * @returns {Promise<import('@x402/core/client').x402Client>}
 */
async function createVaultBackedX402Client(walletIndex = 0) {
  const signer = await buildVaultSigner(walletIndex);

  const client = new x402Client();
  client.register('eip155:*', new ExactEvmScheme(signer));
  for (const network of V1_NETWORKS) {
    client.registerV1(network, new ExactEvmSchemeV1(signer));
  }
  // Surface the signer's address on the client so the payment-history
  // recorder can stamp `from_address` without re-unlocking the vault.
  client.address = signer.address;
  return client;
}

module.exports = {
  buildVaultSigner,
  createVaultBackedX402Client,
  V1_NETWORKS,
};
