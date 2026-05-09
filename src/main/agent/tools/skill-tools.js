/**
 * Skill Tools (Pi-shaped)
 *
 * Currently one tool: `read_skill(name)`. Loads the body of a named
 * skill from the catalog so the agent can autonomously apply a recipe
 * when a user request matches one. Pi's intended skill-discovery flow
 * uses its built-in `read` tool against absolute file paths; we keep
 * that off (security: cwd contains session JSONLs and absolute reads
 * would expose anything the OS user can read), and replace it with a
 * tightly-scoped reader that takes a *name*, not a path.
 *
 * The catalog is the only thing this tool can reach into. Path safety
 * + bundled-wins collision rules + source tagging all live in
 * `skill-catalog.js`.
 *
 * Tier: LOCAL_SAFE — same bracket as `spawn_subagent`. Skills are
 * part of the agent's vocabulary; reading them is no more sensitive
 * than reading the system prompt. (Worth revisiting if remote
 * providers ever ship — user-authored skill bodies could contain
 * private workflow notes the user wouldn't want to send out.)
 */

const { TIERS } = require('../tool-tiers');
const { readSkillByName } = require('../skill-catalog');

function createSkillTools({ agentDir, Type }) {
  if (!agentDir) return [];

  const readSkill = {
    name: 'read_skill',
    label: 'Read skill',
    description:
      "Use this when the user's request clearly maps to one of the skills " +
      "listed under 'Available skills' in your system prompt — call it " +
      'before answering, load the recipe body, then follow it verbatim.',
    tier: TIERS.LOCAL_SAFE,
    promptSnippet: 'load a named skill recipe from the catalog',
    promptGuidelines: [
      'Pass the skill name verbatim — no leading slash, no `skill:` prefix.',
    ],
    parameters: Type.Object({
      name: Type.String({
        minLength: 1,
        description: 'The skill name as listed in available_skills (no slash prefix).',
      }),
    }),
    async execute(_toolCallId, { name }) {
      const result = await readSkillByName({ agentDir, name });
      if (!result) {
        return {
          content: [{ type: 'text', text: `Skill "${name}" not found in the catalog.` }],
          details: { name, error: 'not_found' },
        };
      }
      // Body lives in BOTH content (model) and details (renderer
      // disclosure) so the user can inspect what recipe the agent
      // loaded without going hunting in the JSONL.
      return {
        content: [{ type: 'text', text: result.body }],
        details: {
          name: result.name,
          description: result.description,
          source: result.source,
          body: result.body,
        },
      };
    },
  };

  return [readSkill];
}

module.exports = { createSkillTools };
