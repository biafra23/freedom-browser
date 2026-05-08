/**
 * Freedom Pi Extension
 *
 * The single Pi extension Freedom registers via `DefaultResourceLoader`'s
 * `extensionFactories` option. Phase 1 is intentionally bare — it asserts
 * itself on `session_start` so we can prove the wiring works, and exposes a
 * named factory we can extend in later phases:
 *
 *   - Phase 2: dynamic Ollama provider re-registration on URL change.
 *   - Phase 3: `pi.registerTool(...)` for each browser tool, `pi.on('tool_call', ...)`
 *     calling the broker, `pi.on('tool_result', ...)` forwarding to renderer IPC.
 *   - Phase 4: `before_agent_start` hook applying the active profile's system
 *     prompt + `setActiveTools` from `agent-profiles`.
 *
 * Provider registration during the factory is intentionally skipped here —
 * `pi-runtime.js` pre-registers Ollama on the `modelRegistry` because Pi's
 * `findInitialModel` runs *before* extension binding, when extension provider
 * registrations are still queued. See `docs/agent-playbooks/pi-conventions.md`.
 */

const log = require('../logger');

function createFreedomExtension() {
  return async function freedomExtension(pi) {
    pi.on('session_start', async () => {
      log.info('[Pi] Freedom extension bound to session');
    });

    pi.on('session_shutdown', async (event) => {
      log.info(`[Pi] Freedom extension shutting down (reason: ${event.reason})`);
    });
  };
}

module.exports = { createFreedomExtension };
