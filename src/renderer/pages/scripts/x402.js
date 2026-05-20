// Interstitial logic for freedom://x402. Driven entirely by freedomAPI
// IPC calls — see src/main/x402/ipc.js for the server side.

const pageUrlEl = document.getElementById('page-url');
const amountEl = document.getElementById('amount');
const payToEl = document.getElementById('pay-to');
const networkEl = document.getElementById('network');
const errorEl = document.getElementById('error');
const approveBtn = document.getElementById('approve-btn');
const cancelBtn = document.getElementById('cancel-btn');

function setError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

// "10000" + decimals=6 -> "0.01". No locale formatting — the symbol is
// always the asset's, never a $ sign, even for USDC: the symbol means
// "USD-pegged on this chain," not US dollars.
function formatAmount(rawAmount, decimals) {
  if (typeof rawAmount !== 'string' || !Number.isInteger(decimals)) return null;
  if (!/^\d+$/.test(rawAmount)) return null;
  if (decimals === 0) return rawAmount;
  const padded = rawAmount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function renderDetails({ url, requirements, asset }) {
  const accept = requirements?.accepts?.[0];
  if (!accept) {
    setError('Server payment requirements were malformed.');
    approveBtn.disabled = true;
    return;
  }

  pageUrlEl.textContent = url;
  payToEl.textContent = accept.payTo;
  networkEl.textContent = String(accept.network);

  // V1 uses `maxAmountRequired`, V2 uses `amount`. Same atomic-units shape.
  const rawAmount = accept.amount ?? accept.maxAmountRequired ?? '';
  if (asset && typeof asset.decimals === 'number') {
    const pretty = formatAmount(rawAmount, asset.decimals);
    amountEl.textContent = pretty ? `${pretty} ${asset.symbol}` : `${rawAmount} ${asset.symbol}`;
  } else {
    // Asset not in our allowlist — show raw + the contract address so the
    // user at least sees what they'd be authorising. The approve button
    // stays disabled in this branch; we don't sign for unknown assets.
    amountEl.textContent = `${rawAmount} of ${accept.asset}`;
    approveBtn.disabled = true;
    setError(
      'This site asks for payment in an asset we don’t recognise. ' +
        'Cancel and report the site, or open Settings to add the asset to your allowlist.'
    );
  }
}

async function init() {
  if (!window.freedomAPI?.x402GetDetails) {
    setError('Payment API unavailable on this page.');
    approveBtn.disabled = true;
    return;
  }

  const details = await window.freedomAPI.x402GetDetails();
  if (!details?.success) {
    setError(details?.error || 'No payment details found for this tab.');
    approveBtn.disabled = true;
    return;
  }
  renderDetails(details);
}

approveBtn.onclick = async () => {
  // Guard against double-approve while the vault round-trip is in flight.
  approveBtn.disabled = true;
  cancelBtn.disabled = true;
  setError('');
  approveBtn.textContent = 'Signing…';

  const result = await window.freedomAPI?.x402Approve?.();
  if (result?.success) {
    // Main has already kicked off the re-navigation; this page will be
    // replaced as soon as the paid resource arrives. Nothing more to do.
    return;
  }

  approveBtn.textContent = 'Pay and continue';
  approveBtn.disabled = false;
  cancelBtn.disabled = false;
  setError(result?.error || 'Payment failed.');
};

cancelBtn.onclick = async () => {
  cancelBtn.disabled = true;
  await window.freedomAPI?.x402Cancel?.();
};

init();
