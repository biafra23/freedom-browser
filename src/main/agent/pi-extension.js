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
const { createSkillTools } = require('./tools/skill-tools');
const { createTabTools } = require('./tools/tab-tools');
const { createSubagentTools } = require('./subagent-tools');

const DEFAULT_FREEDOM_INTRO = `You are an AI assistant integrated into the Freedom browser, a privacy-respecting browser for the decentralised web. You help the user by working with their currently active browser tab through a small set of tools.`;

// Pi's default system prompt declares the agent a "coding assistant operating
// inside pi" and points it at pi's docs. That mis-primes a browser agent —
// Gemma 4 e2b in particular tries to fit user requests into a coding-assistant
// frame and misses obvious tool-use moves like "read the page before
// summarising it". We replace the prompt entirely, re-using Pi's own
// toolSnippets/promptGuidelines metadata so per-tool usage hints (set on
// each ToolDefinition) still flow through.
//
// `intro` (optional) overrides the Freedom framing — used by subagents
// whose specialised system prompt becomes the lede.
//
// `isSubagent` (optional) controls whether the main-agent "browser-aware"
// guidelines block is added. Subagents already carry their own focused
// guidance in their intro + promptGuidelines; the main-agent block would
// dilute it.
const STANDARD_MAIN_AGENT_GUIDELINES = `- When the user asks about, summarises, or references the content of a page, call read_current_tab first. Do not infer page content from the URL or a screenshot alone.
- For visual context (what something looks like, layout, images), use screenshot. For text, use read_current_tab. They are complementary.
- After navigate / fill / click, the page may have changed — call read_current_tab if you need to know the new state before answering.
- For questions about current or real-time information — weather, news, prices, scores, recent events — navigate to a search engine (e.g. https://duckduckgo.com/?q=...) and read the result. You have browser tools; do not refuse with "I can't access real-time data".
- Be concise and direct. The user can see your tool calls in the sidebar; you do not need to narrate every step.`;

function formatSkillsSection(skills) {
  if (!skills || skills.length === 0) return '';
  const lines = skills.map((s) => {
    const sourceTag = s.source ? ` (${s.source})` : '';
    return `- ${s.name}${sourceTag}: ${s.description || ''}`.trim();
  });
  return `
Available skills (call read_skill with the skill name to load the recipe, then follow it):
${lines.join('\n')}
`;
}

function buildFreedomSystemPrompt({
  selectedTools = [],
  toolSnippets = {},
  promptGuidelines = [],
  skills = [],
  intro,
  isSubagent = false,
} = {}) {
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
  const introText = intro ?? DEFAULT_FREEDOM_INTRO;
  const standardGuidelines = isSubagent ? '' : `${STANDARD_MAIN_AGENT_GUIDELINES}\n`;
  // Pi only includes its skill section when the agent has the
  // built-in `read` tool active — we don't ship that, so we surface
  // skills here instead. The agent loads bodies via our scoped
  // `read_skill` tool (see tools/skill-tools.js) instead of arbitrary
  // filesystem reads.
  const skillsSection = formatSkillsSection(skills);
  return `${introText}

Available tools:
${toolsList}

Guidelines:
${standardGuidelines}${guidelines ? `${guidelines}\n` : ''}${skillsSection}
Current date: ${today}`;
}

function createFreedomExtension({
  toolCallContext,
  isSubagent = false,
  overrideSystemPrompt,
  modelId,
  agentDir,
  sessionRef,
} = {}) {
  return async function freedomExtension(pi) {
    pi.on('session_shutdown', async (event) => {
      log.info(`[Pi] Freedom extension shutting down (reason: ${event.reason})`);
    });

    pi.on('before_agent_start', async (event) => {
      return {
        systemPrompt: buildFreedomSystemPrompt({
          ...event.systemPromptOptions,
          intro: overrideSystemPrompt,
          isSubagent,
        }),
      };
    });

    if (!toolCallContext) {
      // Phase 1 / Phase 2 path: just lifecycle log, no tool wiring.
      pi.on('session_start', async () => {
        log.info('[Pi] Freedom extension bound to session (no tools)');
      });
      return;
    }

    // Slash commands and compaction-indicator notices are user-facing
    // and shouldn't fire from subagent sessions. The subagent path runs
    // autonomously inside a tool call — no UI, no notice pipe.
    if (!isSubagent) {
      registerFreedomCommands({ pi, sessionRef, toolCallContext });
      registerCompactionNotices({ pi, toolCallContext });
    }

    const browserTools = createBrowserTools({
      webContentsId: toolCallContext.webContentsId ?? null,
      Type,
    });
    // Tab management tools reach the host renderer (where the chat
    // sidebar lives + the tab list is owned) via a different
    // webContents than the active-tab tools. Subagents see them only
    // when their profile permits the relevant tier:
    //   - list_tabs (LOCAL_SENSITIVE) — visible to summarize/extract/research
    //   - open/close/switch_tab (BROWSER_MUTATION) — visible to research_topic
    //     (which already has BROWSER_MUTATION for navigate/click/fill)
    // Worth re-reviewing per-subagent if the tab actions feel out of
    // scope for a given workflow.
    const tabTools = createTabTools({
      hostWebContentsId: toolCallContext.hostWebContentsId ?? null,
      Type,
    });
    // Skill tools work for both main and subagent — skills are
    // independent of who runs them. Subagents whose profile permits
    // LOCAL_SAFE see read_skill in their active set; existing
    // subagent profiles don't include LOCAL_SAFE, so they don't
    // currently. User-defined subagents (later) can opt in via
    // their tier filter.
    const skillTools = createSkillTools({ agentDir, Type });
    // Orchestration tools are main-agent-only — subagents never get
    // spawn_subagent, so depth = 1 by construction.
    const subagentTools = isSubagent
      ? []
      : createSubagentTools({
          parentToolCallContext: toolCallContext,
          modelId,
          agentDir,
          Type,
        });
    const toolMeta = new Map();
    for (const def of [...browserTools, ...tabTools, ...skillTools, ...subagentTools]) {
      toolMeta.set(def.name, { tier: def.tier, label: def.label });
      const { tier, ...piDef } = def;
      pi.registerTool({
        ...piDef,
        executionMode: executionModeForTier(tier),
      });
    }

    // Pi's `noTools: 'builtin'` leaves initialActiveToolNames=[] so every
    // extension-registered tool defaults to OFF — the LLM never sees them
    // until we explicitly enable them. Do it on session_start so the
    // active list is established before the first turn for both main
    // agent and subagent paths. (Pre-fix bug: agent-ipc only enabled the
    // five browser tools; spawn_subagent was registered-but-invisible.
    // Subagent sessions never enabled anything at all.)
    pi.on('session_start', async () => {
      log.info(
        `[Pi] Freedom extension bound to ${isSubagent ? 'subagent' : 'session'}`
      );
      const meta = [...toolMeta.entries()].map(([name, m]) => ({
        name,
        tier: m.tier,
      }));
      const visibleNames = broker.visibleToolNames(toolCallContext.profile, meta);
      pi.setActiveTools(visibleNames);
    });

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

// Slash commands are registered via Pi's extension command API so that
// `session.prompt('/<name>')` invokes them through `_tryExecuteExtensionCommand`
// instead of being sent to the LLM as a literal user message. (The
// BUILTIN_SLASH_COMMANDS Pi exposes are handled by Pi's TUI/RPC harnesses,
// not by AgentSession — embedding hosts must register their own.)
//
// `notify({ kind, text, payload })` is the toolCallContext callback that
// flows results to the renderer over AGENT_CHAT_NOTICE.
function registerFreedomCommands({ pi, sessionRef, toolCallContext }) {
  const notify = (msg) => toolCallContext.onNotice?.(msg);
  const session = () => sessionRef?.session;

  pi.registerCommand('compact', {
    description: 'Manually compact the session context',
    handler: async (_args, ctx) => {
      ctx.compact();
      notify({ kind: 'info', text: 'Compaction started.' });
    },
  });

  pi.registerCommand('copy', {
    description: 'Copy the last assistant message to clipboard',
    handler: async () => {
      const s = session();
      const text = s ? s.getLastAssistantText() : null;
      if (!text) {
        notify({ kind: 'error', text: 'No assistant message to copy yet.' });
        return;
      }
      notify({ kind: 'clipboard', payload: text, text: 'Copied last reply.' });
    },
  });

  pi.registerCommand('clone', {
    description: 'Duplicate this chat at the current position',
    handler: async (_args, ctx) => {
      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) {
        notify({ kind: 'error', text: 'No entry to clone from yet.' });
        return;
      }
      const result = await ctx.fork(leafId, { position: 'at' });
      if (result?.cancelled) return;
      notify({ kind: 'info', text: 'Session cloned.' });
    },
  });

  pi.registerCommand('export', {
    description: 'Export this session (default HTML; pass a path for .html/.jsonl)',
    handler: async (args) => {
      const s = session();
      if (!s) {
        notify({ kind: 'error', text: 'Export is unavailable.' });
        return;
      }
      const target = args?.trim() || undefined;
      try {
        const path = await s.exportToHtml(target);
        notify({ kind: 'info', text: `Exported to ${path}` });
      } catch (err) {
        notify({ kind: 'error', text: `Export failed: ${err?.message || err}` });
      }
    },
  });

  pi.registerCommand('session', {
    description: 'Show session info and stats',
    handler: async () => {
      const s = session();
      const stats = s ? s.getSessionStats() : null;
      if (!stats) {
        notify({ kind: 'error', text: 'No session stats available.' });
        return;
      }
      notify({ kind: 'info', text: formatSessionStats(stats) });
    },
  });

  pi.registerCommand('name', {
    description: 'Set this session display name',
    handler: async (args) => {
      const name = args?.trim();
      if (!name) {
        notify({ kind: 'error', text: 'Usage: /name <new name>' });
        return;
      }
      pi.setSessionName(name);
      notify({ kind: 'info', text: `Session renamed to "${name}".` });
    },
  });
}

// Pi auto-compacts when context fills, plus the user can trigger
// `/compact` manually. Both fire `session_before_compact` (start) and
// `session_compact` (end). We surface a single transient indicator
// in the chat that morphs from "compacting…" to a permanent marker
// showing the result, so the user sees where in the conversation
// the model's earlier context got summarised.
function registerCompactionNotices({ pi, toolCallContext }) {
  const notify = (msg) => toolCallContext.onNotice?.(msg);

  pi.on('session_before_compact', async () => {
    notify({ kind: 'compaction-start', text: 'Compacting context…' });
  });

  pi.on('session_compact', async (event) => {
    const tokensBefore = event?.compactionEntry?.tokensBefore;
    const text = typeof tokensBefore === 'number' && tokensBefore > 0
      ? `Context compacted (${formatTokens(tokensBefore)} tokens summarised)`
      : 'Context compacted';
    notify({ kind: 'compaction-end', text });
  });
}

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatSessionStats(stats) {
  const parts = [];
  if (stats.messageCount != null) parts.push(`${stats.messageCount} messages`);
  if (stats.totalTokens != null) parts.push(`${stats.totalTokens} tokens`);
  if (stats.contextWindow != null) {
    const pct = stats.totalTokens != null
      ? ` (${Math.round((stats.totalTokens / stats.contextWindow) * 100)}%)`
      : '';
    parts.push(`context ${stats.contextWindow}${pct}`);
  }
  return parts.length > 0 ? `Session: ${parts.join(' · ')}` : 'Session: (no stats)';
}

module.exports = {
  createFreedomExtension,
  _internals: {
    buildFreedomSystemPrompt,
    DEFAULT_FREEDOM_INTRO,
    formatSkillsSection,
    registerFreedomCommands,
    registerCompactionNotices,
    formatSessionStats,
    formatTokens,
  },
};
