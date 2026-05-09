/**
 * Wallet Tools (Pi-shaped, read-only — Phase 7d.1)
 *
 * Exposes the user's wallet to the agent at the read-only level only:
 * active-account lookup, native + ERC-20 balances, chain registry.
 * No signing, no sending, no chain switching — those land in 7d.2/7d.3/7d.4.
 *
 * All five tools are tier WALLET_READ (auto-approve). Returning balances
 * and chain configs is public chain data plus the user's own (already-
 * publicly-tied) address; consent prompts would just train users to
 * click-through. The richer consent surface arrives with signing/sending.
 *
 * Vault-locked behaviour: surfaced as a clean throw with a hint to open
 * the wallet sidebar. The visual unlock-on-demand flow that signing
 * needs lands with 7d.3, where every call requires unlock; in 7d.1 the
 * only path that can hit "locked" is "active wallet index > 0 with no
 * explicit address arg" (index 0 reads address from vault-meta.json
 * without unlock).
 *
 * Pi-shaped result for every tool: a single text content block carrying
 * the JSON-stringified payload (model-readable) plus the same payload as
 * a free-form `details` object (renderer-readable).
 */

const { TIERS } = require('../tool-tiers');
const { jsonResult } = require('./_helpers');
const identityManager = require('../../identity-manager');
const balanceService = require('../../wallet/balance-service');
const chainsModule = require('../../wallet/chains');
const chainRegistry = require('../../chain-registry');

const VAULT_LOCKED_HINT =
  'This wallet is locked. Open the wallet sidebar to unlock the vault, or call this tool with an explicit address argument.';

async function getActiveAddressOrThrow() {
  const address = await identityManager.getActiveWalletAddress();
  if (!address) throw new Error(VAULT_LOCKED_HINT);
  return address;
}

function createWalletTools({ Type }) {
  const walletGetAccount = {
    name: 'wallet_get_account',
    label: 'Get active wallet',
    description:
      "Return the user's active wallet address, derivation index, and label. " +
      'Read-only — no private keys are exposed.',
    tier: TIERS.WALLET_READ,
    promptSnippet: "fetch the user's active wallet (address, index, name)",
    promptGuidelines: [
      'Call wallet_get_account when the user asks "what\'s my address" or before any wallet-scoped operation that needs the active address.',
      'The active wallet is one of several the user may have derived — do not assume it is the only one.',
    ],
    parameters: Type.Object({}),
    async execute() {
      const [address, wallets] = await Promise.all([
        identityManager.getActiveWalletAddress(),
        identityManager.getDerivedWallets(),
      ]);
      if (!address) throw new Error(VAULT_LOCKED_HINT);
      const index = identityManager.getActiveWalletIndex();
      const entry = wallets.find((w) => w.index === index);
      return jsonResult({
        address,
        walletIndex: index,
        name: entry?.name ?? null,
      });
    },
  };

  const walletGetBalance = {
    name: 'wallet_get_balance',
    label: 'Get native balance',
    description:
      "Return the native-token balance of an address on a given chain. " +
      'Address defaults to the active wallet; pass an address explicitly to look up arbitrary public balances.',
    tier: TIERS.WALLET_READ,
    promptSnippet: 'fetch the native-token balance for an address on a chain',
    promptGuidelines: [
      'chainId is required — call wallet_list_chains first if you do not know which chain ids the user supports.',
      'Omit address to query the active wallet; pass an explicit address to look up arbitrary public balances.',
    ],
    parameters: Type.Object({
      chainId: Type.Number({ minimum: 1 }),
      address: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_id, { chainId, address }) {
      const target = address || (await getActiveAddressOrThrow());
      const chain = chainsModule.getChain(chainId);
      if (!chain) throw new Error(`unknown chainId ${chainId}`);
      const balance = await balanceService.getNativeBalance(
        target,
        chainId,
        chain.nativeCurrency
      );
      return jsonResult({
        address: target,
        chainId,
        symbol: balance.symbol,
        decimals: balance.decimals,
        formatted: balance.formatted,
        raw: balance.raw,
      });
    },
  };

  const walletGetTokenBalances = {
    name: 'wallet_get_token_balances',
    label: 'Get token balances',
    description:
      'Return the ERC-20 token balances of an address on a given chain. ' +
      'Excludes the native token — use wallet_get_balance for that.',
    tier: TIERS.WALLET_READ,
    promptSnippet: 'fetch ERC-20 token balances for an address on a chain',
    promptGuidelines: [
      'chainId is required.',
      'Returns every ERC-20 Freedom knows about on that chain, including zero balances. Filter your response to what the user asked.',
      'Omit address to query the active wallet.',
    ],
    parameters: Type.Object({
      chainId: Type.Number({ minimum: 1 }),
      address: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_id, { chainId, address }) {
      const target = address || (await getActiveAddressOrThrow());
      const balances = await balanceService.getTokenBalancesForChain(target, chainId);
      return jsonResult({ address: target, chainId, balances });
    },
  };

  const walletListChains = {
    name: 'wallet_list_chains',
    label: 'List chains',
    description:
      "List every chain the user's wallet supports, with id, name, native " +
      'symbol, block explorer, and whether an RPC is configured.',
    tier: TIERS.WALLET_READ,
    promptSnippet: 'list every chain the wallet supports',
    promptGuidelines: [
      'Use wallet_list_chains to translate human chain names ("Ethereum", "Gnosis") to chainId before calling balance / token tools.',
      'isAvailable=false means no RPC is configured for that chain — balance lookups on it will fail until the user adds one.',
    ],
    parameters: Type.Object({}),
    async execute() {
      const chains = chainsModule.getAllChains().map((c) => ({
        chainId: c.chainId,
        name: c.name,
        nativeSymbol: c.nativeCurrency?.symbol ?? null,
        blockExplorer: c.blockExplorer ?? null,
        isAvailable: chainRegistry.isChainAvailable(c.chainId),
      }));
      return jsonResult({ chains });
    },
  };

  const walletGetChain = {
    name: 'wallet_get_chain',
    label: 'Get chain config',
    description:
      'Return the full configuration for one chain by id: name, native ' +
      'currency, block explorer, RPC URLs, contract addresses (if any).',
    tier: TIERS.WALLET_READ,
    promptSnippet: 'fetch the full configuration for one chain by id',
    promptGuidelines: [
      'Useful when you need the block-explorer URL for an address or transaction, or the chain\'s native-token decimals.',
    ],
    parameters: Type.Object({
      chainId: Type.Number({ minimum: 1 }),
    }),
    async execute(_id, { chainId }) {
      const chain = chainsModule.getChain(chainId);
      if (!chain) throw new Error(`unknown chainId ${chainId}`);
      return jsonResult({
        chainId: chain.chainId,
        name: chain.name,
        nativeCurrency: chain.nativeCurrency,
        blockExplorer: chain.blockExplorer ?? null,
        rpcUrls: chain.rpcUrls ?? [],
        contracts: chain.contracts ?? null,
      });
    },
  };

  return [
    walletGetAccount,
    walletGetBalance,
    walletGetTokenBalances,
    walletListChains,
    walletGetChain,
  ];
}

module.exports = { createWalletTools, _internals: { VAULT_LOCKED_HINT } };
