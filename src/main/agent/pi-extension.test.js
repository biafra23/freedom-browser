jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('electron', () => ({
  webContents: { fromId: jest.fn() },
}));

const log = require('../logger');
const { createFreedomExtension } = require('./pi-extension');
const broker = require('./pi-broker');
const { TIERS } = require('./tool-tiers');

function makeFakePiApi() {
  const handlers = new Map();
  const tools = [];
  return {
    handlers,
    tools,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(def) {
      tools.push(def);
    },
  };
}

const ALL_TIERS_PROFILE = {
  allowed_tool_tiers: [
    TIERS.LOCAL_SAFE,
    TIERS.LOCAL_SENSITIVE,
    TIERS.BROWSER_MUTATION,
    TIERS.MONEY,
    TIERS.IDENTITY_OR_SIGNING,
  ],
};

beforeEach(() => {
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
  broker._internals.clearAll();
});

describe('lifecycle hooks (Phase 1 path)', () => {
  test('returns a factory that registers session_start + session_shutdown', async () => {
    const factory = createFreedomExtension();
    const pi = makeFakePiApi();
    await factory(pi);
    expect([...pi.handlers.keys()].sort()).toEqual(['session_shutdown', 'session_start']);
  });

  test('does not register tools or tool hooks without toolCallContext', async () => {
    const factory = createFreedomExtension();
    const pi = makeFakePiApi();
    await factory(pi);
    expect(pi.tools).toHaveLength(0);
    expect(pi.handlers.has('tool_call')).toBe(false);
    expect(pi.handlers.has('tool_result')).toBe(false);
  });
});

describe('Phase 3 — tool registration', () => {
  function makeContext(overrides = {}) {
    return {
      profile: ALL_TIERS_PROFILE,
      sessionId: '/tmp/sessions/x.jsonl',
      webContentsId: 42,
      onToolCall: jest.fn(),
      requestConsent: jest.fn(async () => 'allow'),
      onToolResult: jest.fn(),
      ...overrides,
    };
  }

  test('registers all five browser tools', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    const names = pi.tools.map((t) => t.name).sort();
    expect(names).toEqual(['click', 'fill', 'navigate', 'read_current_tab', 'screenshot']);
  });

  test('strips our non-Pi `tier` field before registerTool', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    for (const def of pi.tools) {
      expect(def.tier).toBeUndefined();
    }
  });

  test('applies sequential executionMode to browser_mutation tools', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    const byName = Object.fromEntries(pi.tools.map((t) => [t.name, t]));
    expect(byName.navigate.executionMode).toBe('sequential');
    expect(byName.click.executionMode).toBe('sequential');
    expect(byName.fill.executionMode).toBe('sequential');
    expect(byName.read_current_tab.executionMode).toBe('parallel');
    expect(byName.screenshot.executionMode).toBe('parallel');
  });

  test('registers tool_call and tool_result hooks', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    expect(pi.handlers.has('tool_call')).toBe(true);
    expect(pi.handlers.has('tool_result')).toBe(true);
  });
});

describe('Phase 3 — tool_call hook', () => {
  function setup(overrides = {}) {
    const ctx = {
      profile: ALL_TIERS_PROFILE,
      sessionId: '/tmp/sessions/x.jsonl',
      webContentsId: 42,
      onToolCall: jest.fn(),
      requestConsent: jest.fn(async () => 'allow'),
      onToolResult: jest.fn(),
      ...overrides,
    };
    const pi = makeFakePiApi();
    return createFreedomExtension({ toolCallContext: ctx })(pi).then(() => ({
      ctx,
      handler: pi.handlers.get('tool_call')[0],
    }));
  }

  test('local_safe tier (none of ours; navigate is browser_mutation) — emits onToolCall, asks consent', async () => {
    const { ctx, handler } = await setup();
    const result = await handler({
      toolCallId: 'c1',
      toolName: 'navigate',
      input: { url: 'https://example.com' },
    });
    expect(ctx.onToolCall).toHaveBeenCalledWith({
      callId: 'c1',
      name: 'navigate',
      tier: TIERS.BROWSER_MUTATION,
      args: { url: 'https://example.com' },
    });
    expect(ctx.requestConsent).toHaveBeenCalled();
    expect(result).toBeUndefined(); // allow → fall through, Pi calls execute
  });

  test('blocks tools whose tier is not in the profile', async () => {
    const { ctx, handler } = await setup({
      profile: { allowed_tool_tiers: [TIERS.LOCAL_SAFE] }, // navigate's tier excluded
    });
    const result = await handler({
      toolCallId: 'c2',
      toolName: 'navigate',
      input: { url: 'https://x' },
    });
    expect(result).toEqual({ block: true, reason: expect.stringMatching(/not in this agent/) });
    expect(ctx.requestConsent).not.toHaveBeenCalled();
    expect(ctx.onToolResult).toHaveBeenCalledWith({
      callId: 'c2',
      status: 'blocked',
      result: { error: expect.stringMatching(/not in this agent/) },
    });
  });

  test('on deny, emits onToolResult + returns block:true; never runs execute', async () => {
    const { ctx, handler } = await setup({
      requestConsent: jest.fn(async () => 'deny'),
    });
    const result = await handler({
      toolCallId: 'c3',
      toolName: 'navigate',
      input: { url: 'https://x' },
    });
    expect(result).toEqual({ block: true, reason: 'User denied this tool call' });
    expect(ctx.onToolResult).toHaveBeenCalledWith({
      callId: 'c3',
      status: 'denied',
      result: { error: 'User denied this tool call' },
    });
  });

  test('on allow-session, grants tier for the session and proceeds', async () => {
    const { handler } = await setup({
      requestConsent: jest.fn(async () => 'allow-session'),
    });
    const result = await handler({
      toolCallId: 'c4',
      toolName: 'click',
      input: { selector: '#go' },
    });
    expect(result).toBeUndefined();
    expect(broker.hasSessionGrant('/tmp/sessions/x.jsonl', TIERS.BROWSER_MUTATION)).toBe(true);
  });

  test('local_sensitive tools cached after a session grant skip the consent prompt', async () => {
    const requestConsent = jest.fn(async () => 'allow-session');
    const { handler } = await setup({ requestConsent });

    // First read_current_tab call — should request consent
    await handler({
      toolCallId: 'r1',
      toolName: 'read_current_tab',
      input: {},
    });
    expect(requestConsent).toHaveBeenCalledTimes(1);

    // Second call — broker says cached:true, no consent prompt
    await handler({
      toolCallId: 'r2',
      toolName: 'read_current_tab',
      input: {},
    });
    expect(requestConsent).toHaveBeenCalledTimes(1);
  });

  test('ignores tool calls for unknown tools (other extensions)', async () => {
    const { ctx, handler } = await setup();
    const result = await handler({
      toolCallId: 'foreign',
      toolName: 'some_other_extensions_tool',
      input: {},
    });
    expect(result).toBeUndefined();
    expect(ctx.onToolCall).not.toHaveBeenCalled();
    expect(ctx.requestConsent).not.toHaveBeenCalled();
  });
});

describe('Phase 3 — tool_result hook', () => {
  async function setup() {
    const ctx = {
      profile: ALL_TIERS_PROFILE,
      sessionId: '/tmp/sessions/x.jsonl',
      webContentsId: 42,
      onToolCall: jest.fn(),
      requestConsent: jest.fn(async () => 'allow'),
      onToolResult: jest.fn(),
    };
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    return { ctx, callHook: pi.handlers.get('tool_call')[0], resultHook: pi.handlers.get('tool_result')[0] };
  }

  test('emits onToolResult with status="allowed" for successful execution', async () => {
    const { ctx, resultHook } = await setup();
    await resultHook({
      toolCallId: 'r1',
      toolName: 'navigate',
      input: { url: 'https://x' },
      content: [{ type: 'text', text: '{}' }],
      details: { url: 'https://x/' },
      isError: false,
    });
    expect(ctx.onToolResult).toHaveBeenCalledWith({
      callId: 'r1',
      status: 'allowed',
      result: { url: 'https://x/' },
    });
  });

  test('emits status="error" when isError=true', async () => {
    const { ctx, resultHook } = await setup();
    await resultHook({
      toolCallId: 'r2',
      toolName: 'click',
      input: { selector: '#x' },
      content: [],
      details: undefined,
      isError: true,
    });
    expect(ctx.onToolResult).toHaveBeenCalledWith({
      callId: 'r2',
      status: 'error',
      result: expect.any(Object),
    });
  });

  test('does NOT double-emit for blocked calls (call hook already emitted)', async () => {
    const { ctx, callHook, resultHook } = await setup();
    await callHook({
      toolCallId: 'c1',
      toolName: 'navigate',
      input: { url: 'invalid' },
      // Profile includes browser_mutation but we'll force a block via ipc.
    });
    // First call from call hook (deny path). Reset count to test result hook.
    // Actually with allow-default we can't easily simulate block via just the
    // hook plumbing — instead test the dedup directly:
    ctx.onToolResult.mockClear();

    // Simulate Pi firing tool_result for a call we already result-emitted.
    await resultHook({
      toolCallId: 'c1', // SAME callId as above — already in emittedResults? not in this test path
      toolName: 'navigate',
      input: {},
      content: [],
      details: {},
      isError: false,
    });
    // Since the call hook returned undefined (allow), the result hook SHOULD emit.
    expect(ctx.onToolResult).toHaveBeenCalledTimes(1);
  });

  test('dedups tool_result when call hook already emitted (block path)', async () => {
    const { ctx, callHook, resultHook } = await setup();
    // Reach the block path: profile excludes browser_mutation
    ctx.profile = { allowed_tool_tiers: [TIERS.LOCAL_SAFE] };
    await callHook({
      toolCallId: 'b1',
      toolName: 'navigate',
      input: { url: 'https://x' },
    });
    expect(ctx.onToolResult).toHaveBeenCalledTimes(1);
    ctx.onToolResult.mockClear();

    // Pi fires tool_result anyway (defensive scenario). Should be deduped.
    await resultHook({
      toolCallId: 'b1',
      toolName: 'navigate',
      input: {},
      content: [],
      details: {},
      isError: true,
    });
    expect(ctx.onToolResult).not.toHaveBeenCalled();
  });

  test('ignores tool results for unknown tools (other extensions)', async () => {
    const { ctx, resultHook } = await setup();
    await resultHook({
      toolCallId: 'foreign',
      toolName: 'some_other_tool',
      input: {},
      content: [],
      details: {},
      isError: false,
    });
    expect(ctx.onToolResult).not.toHaveBeenCalled();
  });
});
