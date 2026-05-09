/**
 * Freedom Permission Broker (Pi-shaped)
 *
 * Per-call decision authority for tool invocations. Lifted from
 * `agent-permissions.js`; the logic is unchanged but the shape is now
 * Pi-native: callers pass `toolName` and `tier` directly (Pi's own
 * registry is the source of truth for tools, so we don't carry our own
 * registry handle here).
 *
 * Two responsibilities:
 *
 *   1. **Visibility filter** — given an agent profile's
 *      `allowed_tool_tiers` and a list of `(name, tier)` pairs (typically
 *      derived from `pi.getAllTools()`), return the names the model is
 *      allowed to see. The Pi-extension layer feeds this into
 *      `pi.setActiveTools(...)` so the agent's tool catalog reflects the
 *      profile.
 *
 *   2. **Per-call evaluation** — when Pi fires `tool_call`, return one of:
 *        { decision: 'allow' }        auto-approved by tier policy or by
 *                                     a previously-cached session grant
 *        { decision: 'ask', tier }    show the consent card; resume when
 *                                     the user answers
 *        { decision: 'block', reason} refuse (unknown tier, blocked tier,
 *                                     or tier not in profile's allowlist)
 *
 * Per-session grants for `session-once` tiers are kept in-memory; the
 * cache resets on app restart by design (no long-term implicit consent).
 * "Session" here means the chat thread (we key by Pi's JSONL path), not
 * a single Pi `AgentSession` instance.
 */

const log = require('../logger');
const { TIER_POLICY, isValidTier } = require('./tool-tiers');

// Renderer-facing consent vocabulary. The renderer's consent buttons emit
// these literal strings over IPC; the extension's tool_call hook reads
// them. One source of truth so the two sides can't drift.
const CONSENT = Object.freeze({
  ALLOW: 'allow',
  ALLOW_SESSION: 'allow-session',
  DENY: 'deny',
});
const CONSENT_VALUES = Object.freeze(Object.values(CONSENT));

// Freedom's default capability set: every tier the broker recognises is
// allowed at the visibility-filter layer. Per-call gating still applies
// based on TIER_POLICY (auto / session-once / always / never), so this is
// not a policy weakening — just the absence of a per-user persona filter.
// We rejected user-pickable "agent profiles" as wrong-shape for browser
// chat (see research/pi-roadmap.md). When subagents land (Phase 5) they
// will carry their own restricted profiles; the main agent uses this one.
const { ALL_TIERS } = require('./tool-tiers');
const DEFAULT_PROFILE = Object.freeze({
  allowed_tool_tiers: Object.freeze([...ALL_TIERS]),
});

// chatId -> Set<tier>
const sessionGrants = new Map();

function tiersForProfile(profile) {
  if (!profile || !Array.isArray(profile.allowed_tool_tiers)) return [];
  return profile.allowed_tool_tiers.filter(isValidTier);
}

/**
 * Filter a list of `(name, tier)` pairs to the names the profile allows.
 * @param {object} profile     Agent profile with `allowed_tool_tiers`.
 * @param {Array<{name:string, tier:string}>} tools
 * @returns {string[]}
 */
function visibleToolNames(profile, tools) {
  const allowed = new Set(tiersForProfile(profile));
  return tools.filter((t) => allowed.has(t.tier)).map((t) => t.name);
}

/**
 * Per-call decision.
 * @param {object} args
 * @param {string} args.toolName
 * @param {string} args.tier
 * @param {object} args.profile
 * @param {string} [args.sessionId]   Stable identifier for the chat thread
 *                                    (we use the Pi JSONL path).
 */
function evaluate({ toolName, tier, profile, sessionId }) {
  if (!isValidTier(tier)) {
    return { decision: 'block', reason: `unknown tier '${tier}' for tool '${toolName}'` };
  }
  const allowedTiers = new Set(tiersForProfile(profile));
  if (!allowedTiers.has(tier)) {
    return {
      decision: 'block',
      reason: `tool '${toolName}' tier '${tier}' is not in this agent's allowed tiers`,
    };
  }
  const policy = TIER_POLICY[tier] || 'always';
  if (policy === 'never') {
    return { decision: 'block', reason: `tier '${tier}' is blocked` };
  }
  if (policy === 'auto') {
    return { decision: 'allow', tier };
  }
  if (policy === 'session-once' && hasSessionGrant(sessionId, tier)) {
    return { decision: 'allow', tier, cached: true };
  }
  return { decision: 'ask', tier, policy };
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
  log.info(`[PiBroker] Session-grant: ${sessionId} ${tier}`);
}

function clearSession(sessionId) {
  if (sessionGrants.delete(sessionId)) {
    log.info(`[PiBroker] Cleared grants for session ${sessionId}`);
  }
}

function clearAll() {
  sessionGrants.clear();
}

module.exports = {
  visibleToolNames,
  evaluate,
  grantForSession,
  hasSessionGrant,
  clearSession,
  CONSENT,
  CONSENT_VALUES,
  DEFAULT_PROFILE,
  _internals: { clearAll },
};
