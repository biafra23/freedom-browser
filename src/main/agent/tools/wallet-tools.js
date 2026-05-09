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
const { jsonResult, makeBridgeCaller } = require('./_helpers');
const identityManager = require('../../identity-manager');
const balanceService = require('../../wallet/balance-service');
const chainsModule = require('../../wallet/chains');
const chainRegistry = require('../../chain-registry');
const ensResolver = require('../../ens-resolver');
const { ENS_REASONS, ENS_RESULT_TYPES } = ensResolver;
const transactionService = require('../../wallet/transaction-service');
const vaultTimer = require('../../vault-timer');
const vaultUnlockBridge = require('../vault-unlock-bridge');

const WALLET_BRIDGE_GLOBAL = '__agentWalletBridge__';
const WALLET_BRIDGE_LABEL = 'wallet';

const VAULT_LOCKED_HINT =
  'This wallet is locked. Open the wallet sidebar to unlock the vault, or call this tool with an explicit address argument.';

async function getActiveAddressOrThrow() {
  const address = await identityManager.getActiveWalletAddress();
  if (!address) throw new Error(VAULT_LOCKED_HINT);
  return address;
}

function shortAddr(address) {
  if (typeof address !== 'string' || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Resolve {address, walletIndex} for a signing request. Caller passes
// either an explicit address (must match one of the user's derived
// wallets exactly — case-insensitive) or omits it for the active wallet.
// Throws with a clear, model-readable error in either failure mode.
// Default-active path skips getDerivedWallets() to avoid the extra
// vault-meta.json read + per-wallet derive loop on every signing call.
async function resolveSigningWallet(address) {
  if (!address) {
    const activeAddress = await identityManager.getActiveWalletAddress();
    if (!activeAddress) throw new Error(VAULT_LOCKED_HINT);
    const activeIndex = identityManager.getActiveWalletIndex();
    return { walletIndex: activeIndex, walletAddress: activeAddress };
  }
  const wallets = await identityManager.getDerivedWallets();
  const lower = address.toLowerCase();
  const match = wallets.find(
    (w) => typeof w.address === 'string' && w.address.toLowerCase() === lower
  );
  if (!match) {
    throw new Error(
      `Address ${address} is not one of the user's derived wallets. Use wallet_list_accounts to see available addresses.`
    );
  }
  return { walletIndex: match.index, walletAddress: match.address };
}

// Two-step unlock: the IDENTITY_OR_SIGNING consent has already fired
// (always-ask tier, fired before execute by pi-extension's tool_call
// hook). This second prompt walks the user through actually unlocking
// the vault when needed. Resolves silently when already unlocked.
async function ensureVaultUnlocked({ hostWebContentsId, reason, signal }) {
  const identity = await identityManager.loadIdentityModule();
  if (identity.isUnlocked()) return;
  await vaultUnlockBridge.requestVaultUnlock({
    reason,
    hostWebContentsId,
    signal,
  });
  // Defensive: race between unlock-resolved and lock-from-elsewhere.
  // If the vault is somehow locked again by the time we proceed,
  // fail clean rather than crashing inside the signer.
  if (!identity.isUnlocked()) {
    throw new Error('Vault locked again before signing could proceed');
  }
}

function createWalletTools({ hostWebContentsId, Type }) {
  const callWalletBridge = makeBridgeCaller({
    globalName: WALLET_BRIDGE_GLOBAL,
    label: WALLET_BRIDGE_LABEL,
    hostId: hostWebContentsId,
  });
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

  const walletListAccounts = {
    name: 'wallet_list_accounts',
    label: 'List wallet accounts',
    description:
      'List every derived wallet account the user has: index, name, address. ' +
      'Returns the active-account index alongside so the model knows which one is currently selected.',
    tier: TIERS.WALLET_READ,
    promptSnippet: 'list every derived wallet account the user has',
    promptGuidelines: [
      'Call wallet_list_accounts when the user asks "how many wallets do I have", "what wallets do I have", "list my accounts", or wants to switch between accounts.',
      'wallet_get_account returns only the active wallet — wallet_list_accounts shows all of them.',
    ],
    parameters: Type.Object({}),
    async execute() {
      const wallets = await identityManager.getDerivedWallets();
      const activeIndex = identityManager.getActiveWalletIndex();
      return jsonResult({ wallets, activeIndex });
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

  // wallet_switch_chain needs to round-trip into the renderer because the
  // selected chain is renderer-side state (walletState.selectedChainId in
  // chain-switcher.js). The renderer's selectChainById path is what fires
  // the dApp `chainChanged` event for any open dApps — silently mutating
  // state from main would skip that and surprise dApp consumers.
  const walletSwitchChain = {
    name: 'wallet_switch_chain',
    label: 'Switch active chain',
    description:
      'Set the wallet sidebar\'s active chain. Updates the wallet UI and ' +
      'emits an EIP-1193 chainChanged event to any open dApp in the active tab.',
    tier: TIERS.BROWSER_MUTATION,
    promptSnippet: 'switch the wallet sidebar to a different chain',
    promptGuidelines: [
      'Only call wallet_switch_chain when the user explicitly asks to switch chains, or when an open dApp needs a different chain to function — never as a silent prerequisite for other wallet tools (those take chainId explicitly).',
      'Pass the chainId as a number (e.g. 1 for Ethereum, 100 for Gnosis). Use wallet_list_chains if the user named a chain by string.',
    ],
    parameters: Type.Object({
      chainId: Type.Number({ minimum: 1 }),
    }),
    async execute(_id, { chainId }) {
      const chain = chainsModule.getChain(chainId);
      if (!chain) throw new Error(`unknown chainId ${chainId}`);
      const ok = await callWalletBridge('setActiveChain', [chainId]);
      if (!ok) throw new Error(`wallet bridge refused chain ${chainId}`);
      return jsonResult({ chainId, name: chain.name });
    },
  };

  const ensResolve = {
    name: 'ens_resolve',
    label: 'Resolve ENS name',
    description:
      'Resolve an ENS name (e.g. "vitalik.eth") to its primary Ethereum address ' +
      'via the Universal Resolver, with multi-RPC quorum.',
    tier: TIERS.WALLET_READ,
    promptSnippet: 'resolve an ENS name to an Ethereum address',
    promptGuidelines: [
      'Call ens_resolve when the user mentions a "*.eth" name and you need its 0x address (e.g. for wallet_get_balance / wallet_get_token_balances on an ENS name).',
      'Some ENS names have no address record set — the tool throws a clear "no address record" error in that case; surface it plainly to the user instead of guessing.',
    ],
    parameters: Type.Object({
      name: Type.String({ minLength: 1 }),
    }),
    async execute(_id, { name }) {
      const result = await ensResolver.resolveEnsAddress(name);
      if (result?.success) {
        return jsonResult({ name: result.name, address: result.address });
      }
      const reason = result?.reason || 'UNKNOWN';
      const detail = result?.error ? `: ${result.error}` : '';
      if (reason === ENS_REASONS.NOT_FOUND) {
        throw new Error(`No address record for ${result.name || name}`);
      }
      if (reason === ENS_REASONS.INVALID_NAME) {
        throw new Error(`Invalid ENS name: ${name}${detail}`);
      }
      throw new Error(`ENS resolve failed (${reason})${detail}`);
    },
  };

  const ensReverse = {
    name: 'ens_reverse',
    label: 'Reverse-resolve address to ENS',
    description:
      'Look up the primary ENS name for an Ethereum address. Many addresses have no primary name set; the tool throws a clear error in that case.',
    tier: TIERS.WALLET_READ,
    promptSnippet: 'look up the primary ENS name for an Ethereum address',
    promptGuidelines: [
      'Call ens_reverse whenever the user references an Ethereum address (0x...) with phrases like "who owns", "whose address", "who is", or just to surface a human-readable name. Always try ens_reverse BEFORE web search or spawning a research subagent — most "who owns this address" questions are answered by the primary ENS name.',
      'Treat the absence of a primary name as normal — do not infer one from a partial match. If ens_reverse returns "no primary ENS name", report that plainly; the user can then choose whether to dispatch a web search.',
    ],
    parameters: Type.Object({
      address: Type.String({ minLength: 1 }),
    }),
    async execute(_id, { address }) {
      const result = await ensResolver.resolveEnsReverse(address);
      if (result?.success) {
        return jsonResult({ address: result.address, name: result.name });
      }
      const reason = result?.reason || 'UNKNOWN';
      const detail = result?.error ? `: ${result.error}` : '';
      if (reason === ENS_REASONS.NOT_FOUND) {
        throw new Error(`No primary ENS name for ${result.address || address}`);
      }
      if (reason === ENS_REASONS.INVALID_ADDRESS) {
        throw new Error(`Invalid Ethereum address: ${address}${detail}`);
      }
      throw new Error(`ENS reverse failed (${reason})${detail}`);
    },
  };

  // Contenthash result shape from ens-resolver:
  //   ok          → { type: 'ok', name, codec, protocol, uri, decoded, trust }
  //   not_found   → { type: 'not_found', reason, name, trust }
  //   unsupported → { type: 'unsupported', reason, name, contentHash, trust }
  //   conflict    → { type: 'conflict', name, trust, groups }   ← security signal
  //   error       → { type: 'error', name, reason, error }
  const ensResolveContenthash = {
    name: 'ens_resolve_contenthash',
    label: 'Resolve ENS contenthash',
    description:
      'Resolve an ENS name\'s contenthash record to a decentralised-content URI ' +
      '(bzz://, ipfs://, or ipns://). Uses multi-RPC quorum; surfaces conflicts as errors.',
    tier: TIERS.WALLET_READ,
    promptSnippet: 'resolve an ENS name to its decentralised content (bzz / ipfs / ipns) URI',
    promptGuidelines: [
      'Call ens_resolve_contenthash when the user wants to visit or inspect the website behind an ENS name, not just its address.',
      'A "conflict" error means RPC providers returned different contenthash records for the same name — treat it as a security signal and tell the user, do not pick one.',
    ],
    parameters: Type.Object({
      name: Type.String({ minLength: 1 }),
    }),
    async execute(_id, { name }) {
      const result = await ensResolver.resolveEnsContent(name);
      if (result?.type === ENS_RESULT_TYPES.OK) {
        return jsonResult({
          name: result.name,
          uri: result.uri,
          protocol: result.protocol,
          decoded: result.decoded,
        });
      }
      const displayName = result?.name || name;
      if (result?.type === ENS_RESULT_TYPES.NOT_FOUND) {
        throw new Error(`No contenthash record for ${displayName} (${result.reason || 'NO_RECORD'})`);
      }
      if (result?.type === ENS_RESULT_TYPES.UNSUPPORTED) {
        throw new Error(`Contenthash for ${displayName} uses an unsupported codec`);
      }
      if (result?.type === ENS_RESULT_TYPES.CONFLICT) {
        throw new Error(
          `RPC quorum failed for ${displayName} — providers returned conflicting contenthash records. Treat as untrusted.`
        );
      }
      const detail = result?.error ? `: ${result.error}` : '';
      throw new Error(`ENS contenthash resolve failed (${result?.reason || 'UNKNOWN'})${detail}`);
    },
  };

  const walletSignMessage = {
    name: 'wallet_sign_message',
    label: 'Sign message',
    description:
      'Sign an EIP-191 personal message with the user\'s wallet. Always asks for ' +
      'consent and walks the user through unlocking the vault if needed. Defaults ' +
      'to the active wallet; pass an explicit address to sign with another derived account.',
    tier: TIERS.IDENTITY_OR_SIGNING,
    promptSnippet: 'sign an EIP-191 personal message with the user\'s wallet',
    promptGuidelines: [
      'Always provide a clear `reason` explaining WHY the user is being asked to sign — the consent prompt shows it to the user verbatim. Be specific (e.g. "to log in to MySite as 0x...", "to prove authorship of this comment"), never generic ("user requested signature").',
      'Defaults to the active wallet. Pass `address` to sign with a specific account from wallet_list_accounts; the address must match one of the user\'s derived wallets exactly.',
      'EIP-191 signs an arbitrary string. For typed structured data (EIP-712 — Permits, OpenSea listings, etc.), wallet_sign_typed_data is the right tool — it gives the user a properly decoded consent card.',
    ],
    parameters: Type.Object({
      message: Type.String({ minLength: 1 }),
      reason: Type.String({
        minLength: 1,
        description: 'Why the user is being asked to sign — shown verbatim in the consent prompt.',
      }),
      address: Type.Optional(Type.String({ minLength: 1 })),
    }),
    formatConsentDescription({ message, reason, address }) {
      const target = address ? shortAddr(address) : 'the active wallet';
      const truncated =
        typeof message === 'string' && message.length > 80
          ? `${message.slice(0, 80)}…`
          : message;
      return `sign a message with ${target}. Reason: ${reason}. Message: "${truncated}"`;
    },
    async execute(_id, { message, reason, address }, signal) {
      const { walletIndex, walletAddress } = await resolveSigningWallet(address);
      await ensureVaultUnlocked({
        hostWebContentsId,
        reason: `Sign a message — ${reason}`,
        signal,
      });
      const identity = await identityManager.loadIdentityModule();
      const privateKey = identity.exportPrivateKey(walletIndex);
      const signature = await transactionService.signPersonalMessage(message, privateKey);
      vaultTimer.resetVaultAutoLockTimer();
      return jsonResult({ address: walletAddress, signature });
    },
  };

  return [
    walletGetAccount,
    walletListAccounts,
    walletGetBalance,
    walletGetTokenBalances,
    walletListChains,
    walletGetChain,
    walletSwitchChain,
    ensResolve,
    ensReverse,
    ensResolveContenthash,
    walletSignMessage,
  ];
}

module.exports = { createWalletTools, _internals: { VAULT_LOCKED_HINT } };
