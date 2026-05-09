/**
 * Freedom Pi Extension
 *
 * The single Pi extension Freedom registers via `DefaultResourceLoader`'s
 * `extensionFactories` option. Two responsibilities:
 *
 *   1. Lifecycle hooks (`session_start`, `session_shutdown`) — Phase 1
 *      footprint, kept for visibility.
 *
 *   2. Tools + permission gate (Phase 3) — when `toolCallContext` is
 *      provided at factory time, register the five browser tools and
 *      install the `tool_call` / `tool_result` hooks that:
 *        - emit `agent:chat:tool-call` IPC immediately so the renderer
 *          can show a card,
 *        - call the broker (`pi-broker.evaluate`) to decide allow / ask
 *          / block,
 *        - on `ask`, await the renderer's consent response via the
 *          per-stream `requestConsent` callback,
 *        - on block / deny, emit `agent:chat:tool-result` ourselves
 *          (Pi may not fire `tool_result` for blocked calls), and
 *        - return `{ block: true, reason }` so Pi never calls execute.
 *
 *      Successful executions emit `agent:chat:tool-result` from the
 *      `tool_result` hook. We dedupe via `emittedResults` in case Pi
 *      also fires `tool_result` after a block (best-of-both safety).
 */

const { Type } = require('typebox');
const log = require('../logger');
const { executionModeForTier } = require('./tool-tiers');
const broker = require('./pi-broker');
const { CONSENT } = require('./pi-broker');
const { createBrowserTools } = require('./tools/browser-tools');

function createFreedomExtension({ toolCallContext } = {}) {
  return async function freedomExtension(pi) {
    pi.on('session_start', async () => {
      log.info('[Pi] Freedom extension bound to session');
    });

    pi.on('session_shutdown', async (event) => {
      log.info(`[Pi] Freedom extension shutting down (reason: ${event.reason})`);
    });

    if (!toolCallContext) return; // Phase 1 / Phase 2 path: no tool wiring.

    const browserTools = createBrowserTools({
      webContentsId: toolCallContext.webContentsId ?? null,
      Type,
    });
    const toolMeta = new Map();
    for (const def of browserTools) {
      toolMeta.set(def.name, { tier: def.tier, label: def.label });
      const { tier, ...piDef } = def;
      pi.registerTool({
        ...piDef,
        executionMode: executionModeForTier(tier),
      });
    }

    // Per-callId dedup: if the broker / consent flow already emitted a
    // tool-result IPC (block / deny path), don't double-emit when Pi
    // also fires tool_result for the same call.
    const emittedResults = new Set();

    const denyAndBlock = (callId, status, reason) => {
      toolCallContext.onToolResult({ callId, status, result: { error: reason } });
      emittedResults.add(callId);
      return { block: true, reason };
    };

    pi.on('tool_call', async (event) => {
      const meta = toolMeta.get(event.toolName);
      if (!meta) return; // Tool registered by some other extension; not ours.

      toolCallContext.onToolCall({
        callId: event.toolCallId,
        name: event.toolName,
        tier: meta.tier,
        args: event.input,
      });

      const decision = broker.evaluate({
        toolName: event.toolName,
        tier: meta.tier,
        profile: toolCallContext.profile,
        sessionId: toolCallContext.sessionId,
      });

      if (decision.decision === 'block') {
        return denyAndBlock(event.toolCallId, 'blocked', decision.reason);
      }

      if (decision.decision === 'ask') {
        const userChoice = await toolCallContext.requestConsent({
          callId: event.toolCallId,
          name: event.toolName,
          tier: meta.tier,
          args: event.input,
          description: meta.label,
        });
        if (userChoice === CONSENT.DENY) {
          return denyAndBlock(event.toolCallId, 'denied', 'User denied this tool call');
        }
        if (userChoice === CONSENT.ALLOW_SESSION && toolCallContext.sessionId) {
          broker.grantForSession(toolCallContext.sessionId, meta.tier);
        }
      }
      // allow / allow-session — fall through so Pi calls execute.
      return undefined;
    });

    pi.on('tool_result', async (event) => {
      if (!toolMeta.has(event.toolName)) return;
      if (emittedResults.has(event.toolCallId)) {
        emittedResults.delete(event.toolCallId);
        return;
      }
      toolCallContext.onToolResult({
        callId: event.toolCallId,
        status: event.isError ? 'error' : 'allowed',
        result: event.details ?? { content: event.content },
      });
    });
  };
}

module.exports = { createFreedomExtension };
