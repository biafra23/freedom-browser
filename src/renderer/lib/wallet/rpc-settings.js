/**
 * RPC settings — relocated to the Networks settings page.
 *
 * Network and RPC-provider configuration (verification strategy, RPC
 * endpoints, provider API keys) now lives in the unified Networks
 * settings page. The wallet sidebar keeps a single deep-link there.
 */

import { createTab } from '../tabs.js';

export function initRpcSettings() {
  const container = document.getElementById('rpc-providers-list');
  if (!container) return;

  container.innerHTML = `
    <p style="font-size: 12px; color: var(--text-secondary, #888); margin: 0 0 8px">
      Network verification and RPC provider keys are managed in Networks settings.
    </p>
    <button type="button" id="rpc-open-networks" class="rpc-provider-btn" style="width: 100%">
      Open Networks settings
    </button>`;

  const btn = document.getElementById('rpc-open-networks');
  if (btn) {
    btn.addEventListener('click', () => createTab('freedom://settings/networks'));
  }
}
