jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { z } = require('zod');
const registry = require('./tools/registry');
const broker = require('./agent-permissions');
const { TIERS } = require('./tool-tiers');

function makeTool(overrides = {}) {
  return {
    name: 'noop',
    description: 'Does nothing.',
    tier: TIERS.LOCAL_SAFE,
    inputSchema: z.object({}),
    execute: jest.fn(async () => 'ok'),
    ...overrides,
  };
}

const profile = (tiers) => ({ allowed_tool_tiers: tiers });

beforeEach(() => {
  registry._internals.clear();
  broker._internals.clearAll();
});

describe('listToolsForProfile', () => {
  test('returns the subset of registered tools whose tier is in the profile allowlist', () => {
    registry.registerAll([
      makeTool({ name: 'safe', tier: TIERS.LOCAL_SAFE }),
      makeTool({ name: 'sens', tier: TIERS.LOCAL_SENSITIVE }),
      makeTool({ name: 'pay', tier: TIERS.MONEY }),
    ]);
    const visible = broker.listToolsForProfile(profile([TIERS.LOCAL_SAFE, TIERS.MONEY]));
    expect(visible.map((t) => t.name).sort()).toEqual(['pay', 'safe']);
  });

  test('returns [] for null / malformed profile', () => {
    expect(broker.listToolsForProfile(null)).toEqual([]);
    expect(broker.listToolsForProfile({})).toEqual([]);
    expect(broker.listToolsForProfile({ allowed_tool_tiers: 'local_safe' })).toEqual([]);
  });
});

describe('evaluate — block paths', () => {
  test('unknown tool', () => {
    const result = broker.evaluate({
      toolName: 'nope',
      profile: profile([TIERS.LOCAL_SAFE]),
      sessionId: 's1',
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/unknown tool/);
  });

  test('tier not in profile', () => {
    registry.register(makeTool({ name: 't', tier: TIERS.MONEY }));
    const result = broker.evaluate({
      toolName: 't',
      profile: profile([TIERS.LOCAL_SAFE]),
      sessionId: 's1',
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/not in this agent/);
  });

  test('blocked tier even if allow-listed (defense in depth)', () => {
    registry.register(makeTool({ name: 't', tier: TIERS.BLOCKED }));
    const result = broker.evaluate({
      toolName: 't',
      profile: profile([TIERS.BLOCKED]),
      sessionId: 's1',
    });
    expect(result.decision).toBe('block');
  });
});

describe('evaluate — allow paths', () => {
  test('local_safe is auto-approved', () => {
    registry.register(makeTool({ name: 't', tier: TIERS.LOCAL_SAFE }));
    const result = broker.evaluate({
      toolName: 't',
      profile: profile([TIERS.LOCAL_SAFE]),
      sessionId: 's1',
    });
    expect(result.decision).toBe('allow');
  });

  test('session-once tier auto-approves once a session grant exists', () => {
    registry.register(makeTool({ name: 't', tier: TIERS.LOCAL_SENSITIVE }));
    const before = broker.evaluate({
      toolName: 't',
      profile: profile([TIERS.LOCAL_SENSITIVE]),
      sessionId: 's1',
    });
    expect(before.decision).toBe('ask');

    broker.grantForSession('s1', TIERS.LOCAL_SENSITIVE);

    const after = broker.evaluate({
      toolName: 't',
      profile: profile([TIERS.LOCAL_SENSITIVE]),
      sessionId: 's1',
    });
    expect(after.decision).toBe('allow');
    expect(after.cached).toBe(true);
  });

  test('session grant is per-session, not global', () => {
    registry.register(makeTool({ name: 't', tier: TIERS.LOCAL_SENSITIVE }));
    broker.grantForSession('s1', TIERS.LOCAL_SENSITIVE);

    const otherSession = broker.evaluate({
      toolName: 't',
      profile: profile([TIERS.LOCAL_SENSITIVE]),
      sessionId: 's-other',
    });
    expect(otherSession.decision).toBe('ask');
  });
});

describe('evaluate — ask paths', () => {
  test('always-ask tiers prompt even with previous calls', () => {
    // MONEY stays at 'always' policy — every spend is a fresh prompt.
    // (BROWSER_MUTATION used to be the example here but moved to
    // 'session-once' because navigate/click/fill chains in normal use
    // made re-prompting too noisy.)
    registry.register(makeTool({ name: 't', tier: TIERS.MONEY }));
    const r1 = broker.evaluate({
      toolName: 't',
      profile: profile([TIERS.MONEY]),
      sessionId: 's1',
    });
    const r2 = broker.evaluate({
      toolName: 't',
      profile: profile([TIERS.MONEY]),
      sessionId: 's1',
    });
    expect(r1.decision).toBe('ask');
    expect(r2.decision).toBe('ask');
  });

  test('browser_mutation honours session grants like local_sensitive', () => {
    registry.register(makeTool({ name: 'navigate', tier: TIERS.BROWSER_MUTATION }));
    const before = broker.evaluate({
      toolName: 'navigate',
      profile: profile([TIERS.BROWSER_MUTATION]),
      sessionId: 's1',
    });
    expect(before.decision).toBe('ask');

    broker.grantForSession('s1', TIERS.BROWSER_MUTATION);

    const after = broker.evaluate({
      toolName: 'navigate',
      profile: profile([TIERS.BROWSER_MUTATION]),
      sessionId: 's1',
    });
    expect(after.decision).toBe('allow');
    expect(after.cached).toBe(true);
  });
});

describe('clearSession', () => {
  test('removes all grants for the session', () => {
    registry.register(makeTool({ name: 't', tier: TIERS.LOCAL_SENSITIVE }));
    broker.grantForSession('s1', TIERS.LOCAL_SENSITIVE);
    expect(broker.hasSessionGrant('s1', TIERS.LOCAL_SENSITIVE)).toBe(true);

    broker.clearSession('s1');
    expect(broker.hasSessionGrant('s1', TIERS.LOCAL_SENSITIVE)).toBe(false);
  });
});
