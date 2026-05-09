const { TIERS, ALL_TIERS, TIER_POLICY, isValidTier } = require('./tool-tiers');

describe('tool-tiers', () => {
  test('TIERS object is frozen and exposes all ten categories', () => {
    expect(Object.isFrozen(TIERS)).toBe(true);
    expect(ALL_TIERS).toHaveLength(10);
    expect(ALL_TIERS).toEqual(
      expect.arrayContaining([
        'local_safe',
        'local_sensitive',
        'external_network',
        'external_with_user_data',
        'money',
        'identity_or_signing',
        'browser_mutation',
        'wallet_read',
        'peer_inference',
        'blocked',
      ])
    );
  });

  test('every tier has a policy entry', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_POLICY[tier]).toBeDefined();
    }
  });

  test('TIER_POLICY assigns sensible defaults', () => {
    expect(TIER_POLICY[TIERS.LOCAL_SAFE]).toBe('auto');
    expect(TIER_POLICY[TIERS.LOCAL_SENSITIVE]).toBe('session-once');
    expect(TIER_POLICY[TIERS.MONEY]).toBe('always');
    // Signing was promoted from 'always' to 'session-once' in 7d.3 so
    // "Allow for session" actually skips re-prompting on subsequent
    // signing calls in the same chat thread.
    expect(TIER_POLICY[TIERS.IDENTITY_OR_SIGNING]).toBe('session-once');
    expect(TIER_POLICY[TIERS.WALLET_READ]).toBe('auto');
    // PEER_INFERENCE is session-once: ask the first time per chat thread,
    // remember the choice. Avoids re-prompting on every follow-up "ask
    // the network" turn while keeping the consent surface visible.
    expect(TIER_POLICY[TIERS.PEER_INFERENCE]).toBe('session-once');
    expect(TIER_POLICY[TIERS.BLOCKED]).toBe('never');
  });

  test('isValidTier accepts known tiers and rejects others', () => {
    expect(isValidTier(TIERS.LOCAL_SAFE)).toBe(true);
    expect(isValidTier('definitely_not_a_tier')).toBe(false);
    expect(isValidTier(undefined)).toBe(false);
    expect(isValidTier(null)).toBe(false);
  });
});
