/**
 * Agent Permissions Broker
 *
 * Per-call decision authority for tool invocations. Two responsibilities:
 *
 *   1. **Visibility filter** — given an agent profile's `allowed_tool_tiers`,
 *      list the registered tools the model is even allowed to see. The
 *      broker hands this list to the agent loop, which forwards it to the
 *      model (via AI SDK's `tools` argument or Pi's tool catalog later).
 *
 *   2. **Per-call evaluation** — when the model emits a tool call, return
 *      one of:
 *        { decision: 'allow' }        auto-approved by tier policy or
 *                                     by a previously-cached session grant
 *        { decision: 'ask', tier }    surface the consent card; resume
 *                                     when the user answers
 *        { decision: 'block', reason} refuse (unknown tool, tier blocked,
 *                                     or tier not in profile's allowlist)
 *
 * Per-session grants for `session-once` tiers are kept in-memory; the
 * cache resets on app restart by design (no long-term implicit consent).
 */

const log = require('../logger');
const { TIER_POLICY, isValidTier } = require('./tool-tiers');
const registry = require('./tools/registry');

// sessionId -> Set<tier>
const sessionGrants = new Map();

function tiersForProfile(profile) {
  if (!profile || !Array.isArray(profile.allowed_tool_tiers)) return [];
  return profile.allowed_tool_tiers.filter(isValidTier);
}

function listToolsForProfile(profile) {
  return registry.listForTiers(tiersForProfile(profile));
}

function evaluate({ toolName, profile, sessionId }) {
  const tool = registry.get(toolName);
  if (!tool) {
    return { decision: 'block', reason: `unknown tool '${toolName}'` };
  }
  const allowedTiers = new Set(tiersForProfile(profile));
  if (!allowedTiers.has(tool.tier)) {
    return {
      decision: 'block',
      reason: `tool '${toolName}' tier '${tool.tier}' is not in this agent's allowed tiers`,
    };
  }

  const policy = TIER_POLICY[tool.tier] || 'always';
  if (policy === 'never') {
    return { decision: 'block', reason: `tier '${tool.tier}' is blocked` };
  }
  if (policy === 'auto') {
    return { decision: 'allow', tier: tool.tier };
  }
  if (policy === 'session-once' && hasSessionGrant(sessionId, tool.tier)) {
    return { decision: 'allow', tier: tool.tier, cached: true };
  }
  return { decision: 'ask', tier: tool.tier, policy };
}

function hasSessionGrant(sessionId, tier) {
  if (!sessionId) return false;
  const set = sessionGrants.get(sessionId);
  return set ? set.has(tier) : false;
}

function grantForSession(sessionId, tier) {
  if (!sessionId || !isValidTier(tier)) return;
  if (!sessionGrants.has(sessionId)) {
    sessionGrants.set(sessionId, new Set());
  }
  sessionGrants.get(sessionId).add(tier);
  log.info(`[AgentPermissions] Session-grant: ${sessionId} ${tier}`);
}

function clearSession(sessionId) {
  if (sessionGrants.delete(sessionId)) {
    log.info(`[AgentPermissions] Cleared grants for session ${sessionId}`);
  }
}

function clearAll() {
  sessionGrants.clear();
}

module.exports = {
  listToolsForProfile,
  evaluate,
  grantForSession,
  hasSessionGrant,
  clearSession,
  // Test hook.
  _internals: { clearAll, sessionGrants },
};
