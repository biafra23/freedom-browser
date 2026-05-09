/**
 * Calldata decoder for the wallet_send_transaction consent card.
 *
 * Recognises two ERC-20 selectors today:
 *   - transfer(address,uint256)  selector 0xa9059cbb
 *   - approve(address,uint256)   selector 0x095ea7b3
 *
 * Either decoder returns a structured `{kind, ...fields}` describing
 * the action so the consent card can show "Transfer 1.0 USDC to 0x..."
 * instead of the raw hex blob. Token symbol + decimals come from the
 * chain-registry's `getToken('${chainId}:${tokenAddress}')` lookup;
 * unknown contracts return null fields (caller falls back to a generic
 * "Contract call" presentation).
 *
 * Returns null for unrecognised selectors. Other selectors (swaps,
 * dApp-specific calls, etc.) are open-ended and intentionally not
 * decoded — better to show "Contract call: 0x..." than to misrepresent
 * a payload we don't fully understand.
 */

const { Interface, formatUnits } = require('ethers');
const { getToken, getTokenKey } = require('../../chain-registry');

const ERC20_INTERFACE = new Interface([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
]);

const TRANSFER_SELECTOR = '0xa9059cbb';
const APPROVE_SELECTOR = '0x095ea7b3';

function lookupToken(chainId, tokenAddress) {
  if (typeof chainId !== 'number' || typeof tokenAddress !== 'string') return null;
  return getToken(getTokenKey(chainId, tokenAddress));
}

function formatTokenAmount(amount, decimals = 18) {
  try {
    return formatUnits(amount, decimals);
  } catch {
    return String(amount);
  }
}

// Both transfer and approve share the same calldata shape: selector +
// (address, uint256). The only differences are the function name (for
// ABI decode), the kind tag, and the field name for the address arg
// (recipient vs spender).
function decodeErc20TwoArg({ tokenAddress, data, chainId, selector, fnName, kind, addressField }) {
  if (typeof data !== 'string' || !data.toLowerCase().startsWith(selector)) {
    return null;
  }
  let parsed;
  try {
    parsed = ERC20_INTERFACE.decodeFunctionData(fnName, data);
  } catch {
    return null;
  }
  const rawAmount = parsed[1].toString();
  const token = lookupToken(chainId, tokenAddress);
  return {
    kind,
    [addressField]: parsed[0],
    rawAmount,
    tokenAddress,
    tokenSymbol: token?.symbol ?? null,
    tokenDecimals: token?.decimals ?? null,
    formattedAmount: token ? formatTokenAmount(rawAmount, token.decimals) : null,
  };
}

/**
 * Decode an ERC-20 transfer call. The `to` field is the token contract
 * address; the recipient lives inside the calldata.
 */
function decodeErc20Transfer({ to: tokenAddress, data, chainId }) {
  return decodeErc20TwoArg({
    tokenAddress,
    data,
    chainId,
    selector: TRANSFER_SELECTOR,
    fnName: 'transfer',
    kind: 'erc20-transfer',
    addressField: 'recipient',
  });
}

function decodeErc20Approve({ to: tokenAddress, data, chainId }) {
  return decodeErc20TwoArg({
    tokenAddress,
    data,
    chainId,
    selector: APPROVE_SELECTOR,
    fnName: 'approve',
    kind: 'erc20-approve',
    addressField: 'spender',
  });
}

/**
 * Try every recognised decoder; return the first match or null.
 */
function decodeKnownAction({ to, data, chainId }) {
  if (!data || data === '0x') return null;
  return (
    decodeErc20Transfer({ to, data, chainId }) ||
    decodeErc20Approve({ to, data, chainId }) ||
    null
  );
}

module.exports = {
  decodeErc20Transfer,
  decodeErc20Approve,
  decodeKnownAction,
  _internals: { TRANSFER_SELECTOR, APPROVE_SELECTOR },
};
