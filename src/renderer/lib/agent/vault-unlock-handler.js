/**
 * Renderer-side bridge for agent-initiated vault unlocks.
 *
 * Listens for AGENT_VAULT_UNLOCK_REQUEST from main, calls the existing
 * `showVaultUnlock(reason)` UI in the wallet sidebar, and reports the
 * outcome back. The wallet sidebar's unlock screen handles Touch ID +
 * password methods uniformly — same UX as the dApp signing flow.
 *
 * After a successful unlock, switch back to the AI sidebar so the user
 * sees the chat continue (signature returned by the tool, follow-up
 * model text). Without this, the wallet sidebar stays open over the
 * chat — fine for dApp consumers (which return to the dApp page) but
 * confusing for agent consumers since the conversation is in the AI
 * sidebar that the unlock prompt obscured.
 */

import { showVaultUnlock } from '../wallet/vault-unlock.js';
import { openAiSidebar } from '../ai-sidebar.js';

export function initAgentVaultUnlockHandler() {
  if (!window.agent?.onVaultUnlockRequest) return;

  window.agent.onVaultUnlockRequest(async ({ requestId, reason }) => {
    try {
      await showVaultUnlock(reason || 'Agent signing request');
      window.agent.respondVaultUnlock({ requestId, status: 'unlocked' });
      openAiSidebar();
    } catch {
      // showVaultUnlock rejects on cancel / dismissal — surface as
      // 'cancelled' so the awaiting tool throws a clean error. Don't
      // auto-switch on cancel; user might still want to interact with
      // the wallet sidebar (e.g. enter the password manually next).
      window.agent.respondVaultUnlock({ requestId, status: 'cancelled' });
    }
  });
}
