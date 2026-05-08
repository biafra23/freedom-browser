/**
 * Tool Permission Tiers
 *
 * Single source of truth for the tier strings used by:
 * - agent-profiles.js (which tiers a profile is allowed to use at all)
 * - tools/browser-tools.js (which tier each tool falls under)
 * - agent-permissions.js (per-call consent decision based on tier policy)
 *
 * Adopted from the Pi permissions research (research/o5-pi-permissions-
 * research.md): a flat enum of risk-bracketed categories, each mapped to
 * a per-call consent policy. The broker reads TIER_POLICY[tool.tier] to
 * decide whether to auto-approve, ask the user, or refuse.
 */

const TIERS = Object.freeze({
  LOCAL_SAFE: 'local_safe',
  LOCAL_SENSITIVE: 'local_sensitive',
  EXTERNAL_NETWORK: 'external_network',
  EXTERNAL_WITH_USER_DATA: 'external_with_user_data',
  MONEY: 'money',
  IDENTITY_OR_SIGNING: 'identity_or_signing',
  BROWSER_MUTATION: 'browser_mutation',
  BLOCKED: 'blocked',
});

const ALL_TIERS = Object.freeze(Object.values(TIERS));

// How the broker treats each tier's per-call decision:
//   'auto'         — always allow without prompting
//   'session-once' — ask the first time per session, remember the choice
//   'always'       — ask every call (with the request payload visible)
//   'never'        — refuse unconditionally
//
// `domain-once` (ask first time per origin) is reserved for Phase 5a-iii
// when external_network tools land that take a URL — for now it falls
// back to 'always' so the user is never surprised.
const TIER_POLICY = Object.freeze({
  [TIERS.LOCAL_SAFE]: 'auto',
  [TIERS.LOCAL_SENSITIVE]: 'session-once',
  [TIERS.EXTERNAL_NETWORK]: 'always',
  [TIERS.EXTERNAL_WITH_USER_DATA]: 'always',
  [TIERS.MONEY]: 'always',
  [TIERS.IDENTITY_OR_SIGNING]: 'always',
  // Browser mutations (navigate / click / fill) honour session grants
  // so a user who clicked "Allow for session" once doesn't get re-
  // prompted on every step of normal browsing. Trade-off accepted: the
  // user trusts the agent for the rest of that session including
  // potentially-irreversible click/fill actions. If that trust window
  // proves too coarse, split into BROWSER_NAVIGATION (session-once) +
  // BROWSER_MUTATION (always) per the Pi-permissions research.
  [TIERS.BROWSER_MUTATION]: 'session-once',
  [TIERS.BLOCKED]: 'never',
});

function isValidTier(tier) {
  return ALL_TIERS.includes(tier);
}

module.exports = { TIERS, ALL_TIERS, TIER_POLICY, isValidTier };
