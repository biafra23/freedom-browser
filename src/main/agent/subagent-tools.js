/**
 * Subagent Orchestration Tool (Pi-shaped)
 *
 * Builds the `spawn_subagent` Pi tool the main agent uses to dispatch
 * specialised child agents (see `subagents.js` for the registry and the
 * runner). One tool, one closure per Pi session — bound to the parent's
 * toolCallContext, model, and agentDir so the spawned subagent inherits
 * the right stream-bound state.
 *
 * Tier: LOCAL_SAFE — the spawn itself doesn't act on the user's behalf;
 * the subagent's tools have their own per-call consent. The only thing
 * the user sees from the main chat is the spawn card and the subagent's
 * final response.
 *
 * Recursion guard: this tool is only registered when `isSubagent` is
 * false. Subagents themselves never get `spawn_subagent` in their tool
 * list, so depth = 1 by construction.
 */

const log = require('../logger');
const { TIERS } = require('./tool-tiers');
const {
  SUBAGENT_IDS,
  listSubagents,
  runSubagent,
} = require('./subagents');

function buildSubagentDescription() {
  const list = listSubagents()
    .map((s) => `  - ${s.id}: ${s.description}`)
    .join('\n');
  return [
    'Dispatch a specialised subagent to perform a focused task and return its result.',
    'Use a subagent when:',
    '  - The task benefits from a fresh, focused context (e.g. a multi-page research request that would otherwise pollute this chat).',
    '  - The task is a well-defined recipe one of the subagents below specialises in.',
    'Available subagents:',
    list,
  ].join('\n');
}

function createSubagentTools({
  parentToolCallContext,
  modelId,
  agentDir,
  Type,
}) {
  if (!parentToolCallContext) return [];
  if (!modelId) return [];
  if (!agentDir) return [];

  const spawnSubagent = {
    name: 'spawn_subagent',
    label: 'Spawn subagent',
    description: buildSubagentDescription(),
    tier: TIERS.LOCAL_SAFE,
    promptSnippet:
      'dispatch a specialised subagent (summarise / research / extract) for focused tasks',
    promptGuidelines: [
      'Prefer spawning a subagent over doing multi-page research yourself — your context stays sharp and the subagent returns a clean answer.',
      'For "summarise this page" requests, prefer summarize_current_page over calling read_current_tab + summarising in your own context.',
    ],
    parameters: Type.Object({
      subagent_id: Type.Union(
        SUBAGENT_IDS.map((id) => Type.Literal(id)),
        { description: 'Which specialised subagent to dispatch.' }
      ),
      prompt: Type.String({
        minLength: 1,
        description:
          'The task for the subagent — a self-contained instruction including any topic, URL, or extraction target it needs.',
      }),
    }),
    async execute(toolCallId, { subagent_id, prompt }, signal) {
      const result = await runSubagent({
        subagentId: subagent_id,
        prompt,
        parentToolCallContext,
        // The renderer uses this to nest the subagent's inner tool
        // cards under the spawn_subagent card instead of appending
        // them as siblings in the assistant bubble.
        parentCallId: toolCallId,
        modelId,
        agentDir,
        signal,
      });
      log.info(
        `[Subagent] spawn_subagent → ${subagent_id} returned ${result.text.length} chars in ${result.durationMs}ms`
      );
      return {
        content: [{ type: 'text', text: result.text || '(no response)' }],
        details: {
          subagent_id,
          turnCount: result.turnCount,
          durationMs: result.durationMs,
        },
      };
    },
  };

  return [spawnSubagent];
}

module.exports = { createSubagentTools, buildSubagentDescription };
