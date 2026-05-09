/**
 * Subagent Registry + Runner
 *
 * Subagents are specialised child agents the main agent dispatches when
 * a task benefits from focus, isolation, or a smaller risk surface.
 * Same shape as Claude Code's Agent tool, CrewAI, AutoGen.
 *
 * Why subagents (vs profile-as-user-picker, which we rejected):
 *   - Context isolation. A research request that touches 5 pages would
 *     pollute the main chat's history. Spawning a research subagent with
 *     its own context, returning only "here's the summary", keeps the
 *     main thread sharp.
 *   - Specialisation beats generalisation in small models. Gemma 4 e2b
 *     (5B) reasons better when given exactly two relevant tools and a
 *     focused system prompt than when picking from five.
 *   - Risk scoping for sensitive tools (Phase 6+): a `dapp_due_diligence`
 *     subagent with read-only network tools and explicitly no signing
 *     access bounds the blast radius.
 *
 * Pi has no native subagent primitive — but its primitives are all we
 * need: an in-memory `SessionManager`, an `AgentSession` we can spawn
 * and dispose at will, the same broker enforcing consent, the same
 * webContents bound to the parent's active tab.
 *
 * Consent inheritance: subagents share the parent's session-grant cache
 * (same chat thread = same trust window). Per-call consent prompts still
 * appear; session-grants don't reset. The consent card flags it as
 * coming from a named subagent so the user knows what's asking.
 *
 * Visibility (v1, opaque): the subagent's internal tool calls do NOT
 * stream into the main chat. The user sees the spawn_subagent tool
 * card and its final response. Consent prompts still appear so the
 * user gates each capability use. Phase 6 adds disclosure UI.
 *
 * Recursion: subagents do NOT receive the spawn_subagent tool. Depth
 * is 1 by design — a subagent can't spawn its own subagent. Enforced
 * by `isSubagent: true` on the child Pi session.
 */

const log = require('../logger');
const { TIERS } = require('./tool-tiers');

// Lazy memoised require to break the pi-runtime ↔ pi-extension ↔
// subagent-tools cycle. pi-runtime is fully loaded by the time any
// subagent is spawned (the runtime had to exist to register the tool
// in the first place), so the require resolves cleanly at call time.
let _piRuntime = null;
function getPiRuntime() {
  if (!_piRuntime) _piRuntime = require('./pi-runtime');
  return _piRuntime;
}

const SUBAGENT_DEFINITIONS = Object.freeze({
  summarize_current_page: Object.freeze({
    id: 'summarize_current_page',
    name: 'Summarise current page',
    description:
      'Read the active browser tab once and return a 3-paragraph plain-prose summary. Single-shot, no follow-ups.',
    systemPrompt: [
      'You are a page-summary subagent inside the Freedom browser.',
      'Your job: call read_current_tab once, then return a tight 3-paragraph summary in plain prose.',
      'Do not navigate, click, or take screenshots. Do not ask follow-up questions.',
      'Be concrete: name the page, its main subject, and the most useful information on it.',
    ].join('\n'),
    allowedToolTiers: Object.freeze([TIERS.LOCAL_SENSITIVE]),
  }),
  research_topic: Object.freeze({
    id: 'research_topic',
    name: 'Research a topic',
    description:
      'Multi-step research: navigate to a search engine, follow promising links, read pages, cross-reference, return a structured summary.',
    systemPrompt: [
      'You are a research subagent inside the Freedom browser.',
      'Given a topic, navigate to a search engine (start with https://duckduckgo.com), search for the topic, then visit the top 2-3 most relevant results and read each.',
      'Cross-reference what you find and return a structured summary covering: what the topic is, key facts (with source URLs), and notable areas of disagreement or uncertainty.',
      'You may navigate, fill search forms, click links, and read pages. Stay within one level of depth — do not chase links from linked pages.',
      'Be concise. The user wants a useful answer, not a 10-paragraph essay.',
    ].join('\n'),
    allowedToolTiers: Object.freeze([TIERS.LOCAL_SENSITIVE, TIERS.BROWSER_MUTATION]),
  }),
  extract_info: Object.freeze({
    id: 'extract_info',
    name: 'Extract info from current page',
    description:
      'Read the current tab and return only the structured information the user asked to extract (e.g. contact details, prices, names).',
    systemPrompt: [
      'You are an information-extraction subagent inside the Freedom browser.',
      'Call read_current_tab once, then return ONLY the structured information the user asked for.',
      'Format as a clean list or table in plain prose. Do not summarise or add commentary — extract.',
      'If the requested information is not present on the page, say so plainly and stop.',
    ].join('\n'),
    allowedToolTiers: Object.freeze([TIERS.LOCAL_SENSITIVE]),
  }),
});

const SUBAGENT_IDS = Object.freeze(Object.keys(SUBAGENT_DEFINITIONS));

function getSubagentDefinition(id) {
  return SUBAGENT_DEFINITIONS[id] ?? null;
}

function listSubagents() {
  return SUBAGENT_IDS.map((id) => {
    const def = SUBAGENT_DEFINITIONS[id];
    return { id: def.id, name: def.name, description: def.description };
  });
}

/**
 * Spawn and drive a subagent to completion. Returns the subagent's final
 * assistant message text.
 *
 * @param {object} args
 * @param {string} args.subagentId
 * @param {string} args.prompt
 * @param {object} args.parentToolCallContext  the main agent's
 *                                             toolCallContext (we forward
 *                                             consent + share sessionId)
 * @param {string} args.modelId                inherited from parent
 * @param {string} args.agentDir               for child Pi services
 * @param {Function} [args.createFreedomPiSession] injected for tests; the
 *                                             default uses pi-runtime via
 *                                             a memoised lazy-require.
 * @param {AbortSignal} [args.signal]          Pi's tool-execute signal.
 *                                             When the parent agent is
 *                                             aborted, we abort the child
 *                                             session so its model turns
 *                                             stop burning Ollama time.
 * @returns {Promise<{text: string, turnCount: number, durationMs: number}>}
 */
async function runSubagent({
  subagentId,
  prompt,
  parentToolCallContext,
  modelId,
  agentDir,
  createFreedomPiSession,
  signal,
}) {
  const def = getSubagentDefinition(subagentId);
  if (!def) {
    throw new Error(`unknown subagent: ${subagentId}`);
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('subagent prompt must be a non-empty string');
  }
  if (signal?.aborted) {
    throw new Error('subagent aborted before start');
  }
  const spawnSession = createFreedomPiSession ?? getPiRuntime().createFreedomPiSession;

  const subagentToolCallContext = makeSubagentToolCallContext({
    parentToolCallContext,
    subagentDef: def,
  });

  const startedAt = Date.now();
  log.info(`[Subagent] spawning ${subagentId}`);
  const { session, dispose } = await spawnSession({
    agentDir,
    modelId,
    // No sessionPath → in-memory child session.
    toolCallContext: subagentToolCallContext,
    overrideSystemPrompt: def.systemPrompt,
    isSubagent: true,
  });

  let text = '';
  let turnCount = 0;
  let agentEnded = false;
  const unsubscribe = session.subscribe((evt) => {
    if (evt.type === 'turn_end') turnCount += 1;
    if (evt.type === 'agent_end') {
      agentEnded = true;
      // The final assistant message is the last with role 'assistant' in
      // event.messages. Pull its text-content blocks.
      const messages = evt.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.role === 'assistant') {
          text = collectTextContent(m.content);
          break;
        }
      }
    }
  });

  // Forward parent's stop signal: if the user hits the main-agent stop
  // button, the AbortSignal from Pi's tool-execute call fires, and we
  // abort the child session so its model turns stop immediately.
  const onParentAbort = () => {
    session.abort().catch((err) => {
      log.warn(`[Subagent ${subagentId}] abort during parent-cancel threw: ${err.message}`);
    });
  };
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    await session.prompt(prompt, { source: 'extension' });
    if (!agentEnded) {
      // prompt() resolved but the subagent never reached agent_end.
      // Treat as failure rather than masking via the (no response) fallback
      // — the user/model gets a real error instead of a silent void.
      throw new Error(
        `subagent ${subagentId} did not complete (no agent_end event)`
      );
    }
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
    unsubscribe();
    dispose();
  }

  const durationMs = Date.now() - startedAt;
  log.info(`[Subagent] ${subagentId} done in ${durationMs}ms (${turnCount} turns)`);
  return { text, turnCount, durationMs };
}

function collectTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

function makeSubagentToolCallContext({ parentToolCallContext, subagentDef }) {
  const subagentLabel = subagentDef.name;
  return {
    profile: { allowed_tool_tiers: [...subagentDef.allowedToolTiers] },
    // Share the parent's chat-thread sessionId so any session-grants the
    // user already gave (e.g. browser_mutation for this chat) carry over
    // and the subagent doesn't re-prompt for the same tier.
    sessionId: parentToolCallContext.sessionId,
    webContentsId: parentToolCallContext.webContentsId,
    // Inner tool calls stay opaque to the main chat in v1 — log them for
    // debugging but don't surface in the renderer's main flow.
    onToolCall: (event) => {
      log.info(`[Subagent ${subagentDef.id}] tool_call: ${event.name}`);
    },
    onToolResult: (event) => {
      log.info(
        `[Subagent ${subagentDef.id}] tool_result: ${event.callId} (${event.status})`
      );
    },
    // Consent DOES surface to the user — they need to gate each
    // capability use. Description prefixed with the subagent name so the
    // consent card makes the source obvious.
    requestConsent: (event) =>
      parentToolCallContext.requestConsent({
        ...event,
        description: `[${subagentLabel}] ${event.description ?? event.name}`,
      }),
  };
}

module.exports = {
  SUBAGENT_DEFINITIONS,
  SUBAGENT_IDS,
  getSubagentDefinition,
  listSubagents,
  runSubagent,
  _internals: { makeSubagentToolCallContext, collectTextContent },
};
