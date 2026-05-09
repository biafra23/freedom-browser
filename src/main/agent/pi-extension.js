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

// Pi's default system prompt declares the agent a "coding assistant operating
// inside pi" and points it at pi's docs. That mis-primes a browser agent —
// Gemma 4 e2b in particular tries to fit user requests into a coding-assistant
// frame and misses obvious tool-use moves like "read the page before
// summarising it". We replace the prompt entirely with Freedom framing,
// re-using Pi's own toolSnippets/promptGuidelines metadata so per-tool
// usage hints (set on each ToolDefinition) still flow through.
function buildFreedomSystemPrompt({ selectedTools = [], toolSnippets = {}, promptGuidelines = [] } = {}) {
  const visible = selectedTools.filter((name) => !!toolSnippets[name]);
  const toolsList =
    visible.length > 0
      ? visible.map((name) => `- ${name}: ${toolSnippets[name]}`).join('\n')
      : '(none)';
  const guidelines = promptGuidelines
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => `- ${g}`)
    .join('\n');
  const today = new Date().toISOString().slice(0, 10);
  return `You are an AI assistant integrated into the Freedom browser, a privacy-respecting browser for the decentralised web. You help the user by working with their currently active browser tab through a small set of tools.

Available tools:
${toolsList}

Guidelines:
- When the user asks about, summarises, or references the content of a page, call read_current_tab first. Do not infer page content from the URL or a screenshot alone.
- For visual context (what something looks like, layout, images), use screenshot. For text, use read_current_tab. They are complementary.
- After navigate / fill / click, the page may have changed — call read_current_tab if you need to know the new state before answering.
- Be concise and direct. The user can see your tool calls in the sidebar; you do not need to narrate every step.
${guidelines ? `${guidelines}\n` : ''}
Current date: ${today}`;
}

function createFreedomExtension({ toolCallContext } = {}) {
  return async function freedomExtension(pi) {
    pi.on('session_start', async () => {
      log.info('[Pi] Freedom extension bound to session');
    });

    pi.on('session_shutdown', async (event) => {
      log.info(`[Pi] Freedom extension shutting down (reason: ${event.reason})`);
    });

    pi.on('before_agent_start', async (event) => {
      return {
        systemPrompt: buildFreedomSystemPrompt(event.systemPromptOptions),
      };
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

module.exports = { createFreedomExtension, _internals: { buildFreedomSystemPrompt } };
