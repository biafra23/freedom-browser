jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { z } = require('zod');
const registry = require('./registry');
const { TIERS } = require('../tool-tiers');

const noopExec = jest.fn(async () => 'ok');

function makeTool(overrides = {}) {
  return {
    name: 'noop',
    description: 'Does nothing.',
    tier: TIERS.LOCAL_SAFE,
    inputSchema: z.object({}),
    execute: noopExec,
    ...overrides,
  };
}

beforeEach(() => {
  registry._internals.clear();
  noopExec.mockClear();
});

describe('register', () => {
  test('accepts a valid definition', () => {
    expect(() => registry.register(makeTool())).not.toThrow();
    expect(registry.get('noop')).not.toBeNull();
  });

  test('rejects missing name', () => {
    expect(() => registry.register(makeTool({ name: '' }))).toThrow(/name/);
  });

  test('rejects missing description', () => {
    expect(() => registry.register(makeTool({ description: '' }))).toThrow(/description/);
  });

  test('rejects unknown tier', () => {
    expect(() => registry.register(makeTool({ tier: 'unknown_tier' }))).toThrow(/tier/);
  });

  test('rejects non-Zod inputSchema', () => {
    expect(() =>
      registry.register(makeTool({ inputSchema: { whatever: true } }))
    ).toThrow(/Zod/);
  });

  test('rejects non-function execute', () => {
    expect(() => registry.register(makeTool({ execute: null }))).toThrow(/execute/);
  });

  test('overwriting an existing name logs a warning but does not throw', () => {
    registry.register(makeTool());
    const log = require('../../logger');
    expect(() => registry.register(makeTool())).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/Re-registering/));
  });
});

describe('listAll / listForTiers', () => {
  test('listAll returns every registered tool', () => {
    registry.registerAll([
      makeTool({ name: 'a' }),
      makeTool({ name: 'b', tier: TIERS.BROWSER_MUTATION }),
    ]);
    expect(registry.listAll().map((t) => t.name).sort()).toEqual(['a', 'b']);
  });

  test('listForTiers filters by the given tier set', () => {
    registry.registerAll([
      makeTool({ name: 'safe', tier: TIERS.LOCAL_SAFE }),
      makeTool({ name: 'mut', tier: TIERS.BROWSER_MUTATION }),
      makeTool({ name: 'pay', tier: TIERS.MONEY }),
    ]);
    const allowed = registry.listForTiers([TIERS.LOCAL_SAFE, TIERS.BROWSER_MUTATION]);
    expect(allowed.map((t) => t.name).sort()).toEqual(['mut', 'safe']);
  });

  test('listForTiers returns [] for non-array input', () => {
    expect(registry.listForTiers(null)).toEqual([]);
    expect(registry.listForTiers('local_safe')).toEqual([]);
  });
});

describe('runTool', () => {
  test('throws on unknown tool', async () => {
    await expect(registry.runTool('nope', {})).rejects.toThrow(/unknown tool/);
  });

  test('parses the input via the schema and forwards to execute', async () => {
    registry.register(
      makeTool({
        name: 'echo',
        inputSchema: z.object({ msg: z.string() }),
        execute: jest.fn(async (input, ctx) => ({ input, ctx })),
      })
    );
    const out = await registry.runTool('echo', { msg: 'hi' }, { sessionId: 's1' });
    expect(out.input).toEqual({ msg: 'hi' });
    expect(out.ctx).toEqual({ sessionId: 's1' });
  });

  test('throws ZodError when input fails validation', async () => {
    registry.register(
      makeTool({
        name: 'strict',
        inputSchema: z.object({ url: z.string().url() }),
      })
    );
    await expect(registry.runTool('strict', { url: 'not a url' })).rejects.toThrow();
  });
});
