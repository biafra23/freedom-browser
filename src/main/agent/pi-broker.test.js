jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const broker = require('./pi-broker');
const { TIERS } = require('./tool-tiers');

const profile = (tiers) => ({ allowed_tool_tiers: tiers });

beforeEach(() => {
  broker._internals.clearAll();
});

describe('visibleToolNames', () => {
  test('returns the subset whose tier is in the profile allowlist', () => {
    const visible = broker.visibleToolNames(
      profile([TIERS.LOCAL_SAFE, TIERS.MONEY]),
      [
        { name: 'safe', tier: TIERS.LOCAL_SAFE },
        { name: 'sens', tier: TIERS.LOCAL_SENSITIVE },
        { name: 'pay', tier: TIERS.MONEY },
      ]
    );
    expect(visible.sort()).toEqual(['pay', 'safe']);
  });

  test('returns [] for null / malformed profile', () => {
    expect(broker.visibleToolNames(null, [])).toEqual([]);
    expect(broker.visibleToolNames({}, [])).toEqual([]);
    expect(
      broker.visibleToolNames({ allowed_tool_tiers: 'local_safe' }, [
        { name: 't', tier: TIERS.LOCAL_SAFE },
      ])
    ).toEqual([]);
  });
});

describe('evaluate — block paths', () => {
  test('unknown tier', () => {
    const result = broker.evaluate({
      toolName: 'x',
      tier: 'bogus',
      profile: profile([TIERS.LOCAL_SAFE]),
      sessionId: 's1',
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/unknown tier/);
  });

  test('tier not in profile', () => {
    const result = broker.evaluate({
      toolName: 't',
      tier: TIERS.MONEY,
      profile: profile([TIERS.LOCAL_SAFE]),
      sessionId: 's1',
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/not in this agent/);
  });

  test('blocked tier even if allow-listed (defense in depth)', () => {
    const result = broker.evaluate({
      toolName: 't',
      tier: TIERS.BLOCKED,
      profile: profile([TIERS.BLOCKED]),
      sessionId: 's1',
    });
    expect(result.decision).toBe('block');
  });
});

describe('evaluate — allow paths', () => {
  test('local_safe is auto-approved', () => {
    const result = broker.evaluate({
      toolName: 't',
      tier: TIERS.LOCAL_SAFE,
      profile: profile([TIERS.LOCAL_SAFE]),
      sessionId: 's1',
    });
    expect(result.decision).toBe('allow');
  });

  test('session-once tier auto-approves once a session grant exists', () => {
    const before = broker.evaluate({
      toolName: 't',
      tier: TIERS.LOCAL_SENSITIVE,
      profile: profile([TIERS.LOCAL_SENSITIVE]),
      sessionId: 's1',
    });
    expect(before.decision).toBe('ask');

    broker.grantForSession('s1', TIERS.LOCAL_SENSITIVE);

    const after = broker.evaluate({
      toolName: 't',
      tier: TIERS.LOCAL_SENSITIVE,
      profile: profile([TIERS.LOCAL_SENSITIVE]),
      sessionId: 's1',
    });
    expect(after.decision).toBe('allow');
    expect(after.cached).toBe(true);
  });

  test('session grant is per-session, not global', () => {
    broker.grantForSession('s1', TIERS.LOCAL_SENSITIVE);
    const otherSession = broker.evaluate({
      toolName: 't',
      tier: TIERS.LOCAL_SENSITIVE,
      profile: profile([TIERS.LOCAL_SENSITIVE]),
      sessionId: 's-other',
    });
    expect(otherSession.decision).toBe('ask');
  });
});

describe('evaluate — ask paths', () => {
  test('always-ask tiers prompt every call', () => {
    const r1 = broker.evaluate({
      toolName: 't',
      tier: TIERS.MONEY,
      profile: profile([TIERS.MONEY]),
      sessionId: 's1',
    });
    const r2 = broker.evaluate({
      toolName: 't',
      tier: TIERS.MONEY,
      profile: profile([TIERS.MONEY]),
      sessionId: 's1',
    });
    expect(r1.decision).toBe('ask');
    expect(r2.decision).toBe('ask');
  });

  test('browser_mutation honours session grants', () => {
    const before = broker.evaluate({
      toolName: 'navigate',
      tier: TIERS.BROWSER_MUTATION,
      profile: profile([TIERS.BROWSER_MUTATION]),
      sessionId: 's1',
    });
    expect(before.decision).toBe('ask');
    broker.grantForSession('s1', TIERS.BROWSER_MUTATION);
    const after = broker.evaluate({
      toolName: 'navigate',
      tier: TIERS.BROWSER_MUTATION,
      profile: profile([TIERS.BROWSER_MUTATION]),
      sessionId: 's1',
    });
    expect(after.decision).toBe('allow');
    expect(after.cached).toBe(true);
  });
});

describe('clearSession', () => {
  test('removes all grants for the session', () => {
    broker.grantForSession('s1', TIERS.LOCAL_SENSITIVE);
    expect(broker.hasSessionGrant('s1', TIERS.LOCAL_SENSITIVE)).toBe(true);
    broker.clearSession('s1');
    expect(broker.hasSessionGrant('s1', TIERS.LOCAL_SENSITIVE)).toBe(false);
  });
});
