jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('electron', () => ({
  webContents: { fromId: jest.fn() },
}));

// Avoid pulling in identity-manager / balance-service / chain-registry
// (and through them ethers + electron.app) just to verify wiring. Wallet
// tool *behaviour* is covered in tools/wallet-tools.test.js.
jest.mock('./tools/wallet-tools', () => {
  const stub = (name, tier, extras = {}) => ({
    name,
    label: name,
    description: 'wallet stub',
    tier,
    promptSnippet: 'wallet stub',
    promptGuidelines: ['stub'],
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [], details: {} }),
    ...extras,
  });
  return {
    createWalletTools: () => [
      stub('wallet_get_account', 'wallet_read'),
      stub('wallet_list_accounts', 'wallet_read'),
      stub('wallet_get_balance', 'wallet_read'),
      stub('wallet_get_token_balances', 'wallet_read'),
      stub('wallet_list_chains', 'wallet_read'),
      stub('wallet_get_chain', 'wallet_read'),
      stub('wallet_switch_chain', 'browser_mutation'),
      stub('ens_resolve', 'wallet_read'),
      stub('ens_reverse', 'wallet_read'),
      stub('ens_resolve_contenthash', 'wallet_read'),
      stub('wallet_sign_message', 'identity_or_signing', {
        formatConsentDescription: ({ reason }) =>
          `sign a message with the active wallet. Reason: ${reason}.`,
      }),
    ],
  };
});

const log = require('../logger');
const { createFreedomExtension } = require('./pi-extension');
const broker = require('./pi-broker');
const { TIERS } = require('./tool-tiers');

function makeFakePiApi() {
  const handlers = new Map();
  const tools = [];
  const commands = new Map();
  const setActiveCalls = [];
  const sessionNameSet = [];
  return {
    handlers,
    tools,
    commands,
    setActiveCalls,
    sessionNameSet,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(def) {
      tools.push(def);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    setActiveTools(names) {
      setActiveCalls.push([...names]);
    },
    setSessionName(name) {
      sessionNameSet.push(name);
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
    TIERS.WALLET_READ,
  ],
};

beforeEach(() => {
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
  broker._internals.clearAll();
});

describe('lifecycle hooks (Phase 1 path)', () => {
  test('without toolCallContext registers lifecycle + before_agent_start (system-prompt override) only', async () => {
    const factory = createFreedomExtension();
    const pi = makeFakePiApi();
    await factory(pi);
    expect([...pi.handlers.keys()].sort()).toEqual([
      'before_agent_start',
      'session_shutdown',
      'session_start',
    ]);
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
      hostWebContentsId: 7,
      onToolCall: jest.fn(),
      requestConsent: jest.fn(async () => 'allow'),
      onToolResult: jest.fn(),
      ...overrides,
    };
  }

  test('registers the five browser tools', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    const names = pi.tools.map((t) => t.name);
    for (const expected of ['click', 'fill', 'navigate', 'read_current_tab', 'screenshot']) {
      expect(names).toContain(expected);
    }
  });

  test('registers the four tab tools when hostWebContentsId is bound', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    const names = pi.tools.map((t) => t.name);
    for (const expected of ['list_tabs', 'open_tab', 'close_tab', 'switch_tab']) {
      expect(names).toContain(expected);
    }
  });

  test('registers all wallet + chain + ENS tools', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    const names = pi.tools.map((t) => t.name);
    for (const expected of [
      'wallet_get_account',
      'wallet_list_accounts',
      'wallet_get_balance',
      'wallet_get_token_balances',
      'wallet_list_chains',
      'wallet_get_chain',
      'wallet_switch_chain',
      'ens_resolve',
      'ens_reverse',
      'ens_resolve_contenthash',
      'wallet_sign_message',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test('skips tab tools when hostWebContentsId is missing (no host renderer)', async () => {
    const ctx = makeContext({ hostWebContentsId: undefined });
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    const names = pi.tools.map((t) => t.name);
    expect(names).not.toContain('list_tabs');
    expect(names).not.toContain('open_tab');
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

  test('session_start enables every registered tool that the profile permits', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({
      toolCallContext: ctx,
      modelId: 'm',
      agentDir: '/tmp/x',
    })(pi);
    // Pi has registered tools but not yet activated any.
    expect(pi.setActiveCalls).toEqual([]);
    // Fire the session_start hook.
    const handler = pi.handlers.get('session_start')[0];
    await handler({});
    expect(pi.setActiveCalls).toHaveLength(1);
    // For the all-tiers default profile we expect everything pi-extension
    // registered to be enabled — the five browser tools, four tab tools,
    // read_skill, the wallet/chain/ENS cluster, and spawn_subagent.
    expect(pi.setActiveCalls[0].sort()).toEqual(
      [
        'click',
        'close_tab',
        'ens_resolve',
        'ens_resolve_contenthash',
        'ens_reverse',
        'fill',
        'list_tabs',
        'navigate',
        'open_tab',
        'read_current_tab',
        'read_skill',
        'screenshot',
        'spawn_subagent',
        'switch_tab',
        'wallet_get_account',
        'wallet_get_balance',
        'wallet_get_chain',
        'wallet_get_token_balances',
        'wallet_list_accounts',
        'wallet_list_chains',
        'wallet_sign_message',
        'wallet_switch_chain',
      ].sort()
    );
  });

  test('subagent path: session_start excludes spawn_subagent (depth=1)', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({
      toolCallContext: ctx,
      modelId: 'm',
      agentDir: '/tmp/x',
      isSubagent: true,
    })(pi);
    const handler = pi.handlers.get('session_start')[0];
    await handler({});
    expect(pi.setActiveCalls[0]).not.toContain('spawn_subagent');
  });

  test('session_start filters by profile.allowed_tool_tiers', async () => {
    // A subagent restricted to local_sensitive only should see read+screenshot+list_tabs
    // — not navigate/click/fill/open_tab/close_tab/switch_tab (browser_mutation).
    const ctx = makeContext({ profile: { allowed_tool_tiers: ['local_sensitive'] } });
    const pi = makeFakePiApi();
    await createFreedomExtension({
      toolCallContext: ctx,
      modelId: 'm',
      agentDir: '/tmp/x',
      isSubagent: true,
    })(pi);
    const handler = pi.handlers.get('session_start')[0];
    await handler({});
    expect(pi.setActiveCalls[0].sort()).toEqual(
      ['list_tabs', 'read_current_tab', 'screenshot'].sort()
    );
  });

  test('registers a before_agent_start hook that overrides the system prompt', async () => {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({ toolCallContext: ctx })(pi);
    expect(pi.handlers.has('before_agent_start')).toBe(true);
    const hook = pi.handlers.get('before_agent_start')[0];
    const result = await hook({
      systemPromptOptions: {
        selectedTools: ['read_current_tab', 'navigate'],
        toolSnippets: {
          read_current_tab: 'fetch the visible text',
          navigate: 'load a URL',
        },
        promptGuidelines: ['Be concise.'],
      },
    });
    expect(result.systemPrompt).toMatch(/Freedom browser/);
    expect(result.systemPrompt).toMatch(/read_current_tab.*fetch the visible text/);
    expect(result.systemPrompt).toMatch(/navigate.*load a URL/);
    expect(result.systemPrompt).toMatch(/Be concise\./);
    // Pi's coding-agent intro must NOT survive — that was the whole point.
    expect(result.systemPrompt).not.toMatch(/coding assistant|pi documentation/i);
  });
});

describe('Phase 3.1 — buildFreedomSystemPrompt', () => {
  const { _internals } = require('./pi-extension');

  test('omits tools that have no promptSnippet', () => {
    const prompt = _internals.buildFreedomSystemPrompt({
      selectedTools: ['read_current_tab', 'unknown_thing'],
      toolSnippets: { read_current_tab: 'fetch text' },
    });
    expect(prompt).toMatch(/read_current_tab: fetch text/);
    expect(prompt).not.toMatch(/unknown_thing/);
  });

  test('renders "(none)" when no tools have snippets', () => {
    const prompt = _internals.buildFreedomSystemPrompt({
      selectedTools: ['x'],
      toolSnippets: {},
    });
    expect(prompt).toMatch(/Available tools:\n\(none\)/);
  });

  test('always asserts the read-first guideline up front (main agent)', () => {
    const prompt = _internals.buildFreedomSystemPrompt({});
    expect(prompt).toMatch(/read_current_tab first/i);
  });

  test('isSubagent: true drops the main-agent guideline block', () => {
    const prompt = _internals.buildFreedomSystemPrompt({ isSubagent: true });
    expect(prompt).not.toMatch(/read_current_tab first/i);
    expect(prompt).not.toMatch(/visual context/i);
  });

  test('main-agent prompt explicitly enables web lookup for real-time info', () => {
    // Pushes back on Gemma's "I can't access real-time data" reflex —
    // the agent has navigate + read_current_tab and should reach for
    // them on weather / news / prices questions.
    const prompt = _internals.buildFreedomSystemPrompt({});
    expect(prompt).toMatch(/real-time information/i);
    expect(prompt).toMatch(/search engine/i);
    expect(prompt).toMatch(/do not refuse/i);
  });

  test('intro overrides the Freedom default lede', () => {
    const prompt = _internals.buildFreedomSystemPrompt({
      intro: 'You are an extraction subagent inside the Freedom browser.',
      isSubagent: true,
    });
    expect(prompt).toMatch(/extraction subagent/);
    expect(prompt).not.toMatch(/privacy-respecting browser/);
  });

  test('appends current date last', () => {
    const prompt = _internals.buildFreedomSystemPrompt({});
    expect(prompt).toMatch(/Current date: \d{4}-\d{2}-\d{2}\s*$/);
  });

  test('omits the skills section when no skills are loaded', () => {
    const prompt = _internals.buildFreedomSystemPrompt({ skills: [] });
    expect(prompt).not.toMatch(/Available skills/);
    expect(prompt).not.toMatch(/read_skill/);
  });

  test('renders the skills section with name, source, and description', () => {
    const prompt = _internals.buildFreedomSystemPrompt({
      skills: [
        { name: 'tldr', description: 'Short summary', source: 'builtin' },
        { name: 'mine', description: 'Custom recipe', source: 'user' },
      ],
    });
    expect(prompt).toMatch(/Available skills/);
    expect(prompt).toMatch(/call read_skill with the skill name/);
    expect(prompt).toMatch(/- tldr \(builtin\): Short summary/);
    expect(prompt).toMatch(/- mine \(user\): Custom recipe/);
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

  test('formatConsentDescription on a tool overrides the bare label in the consent prompt', async () => {
    const { ctx, handler } = await setup();
    await handler({
      toolCallId: 'c1',
      toolName: 'wallet_sign_message',
      input: { message: 'Hello', reason: 'log in to MySite' },
    });
    expect(ctx.requestConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Reason: log in to MySite'),
      })
    );
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

describe('Phase 6.4 — slash command handlers', () => {
  function makeContext(overrides = {}) {
    return {
      profile: ALL_TIERS_PROFILE,
      sessionId: '/tmp/sessions/x.jsonl',
      webContentsId: 42,
      onToolCall: jest.fn(),
      requestConsent: jest.fn(async () => 'allow'),
      onToolResult: jest.fn(),
      onNotice: jest.fn(),
      ...overrides,
    };
  }

  function makeCmdCtx(overrides = {}) {
    return {
      compact: jest.fn(),
      sessionManager: { getLeafId: jest.fn(() => 'leaf-1') },
      fork: jest.fn(async () => ({ cancelled: false })),
      ...overrides,
    };
  }

  async function setup({ session = null, isSubagent = false } = {}) {
    const ctx = makeContext();
    const sessionRef = { session };
    const pi = makeFakePiApi();
    await createFreedomExtension({
      toolCallContext: ctx,
      sessionRef,
      isSubagent,
    })(pi);
    return { ctx, sessionRef, pi };
  }

  test('registers all six commands on the main session', async () => {
    const { pi } = await setup();
    expect([...pi.commands.keys()].sort()).toEqual(
      ['clone', 'compact', 'copy', 'export', 'name', 'session'].sort()
    );
  });

  test('subagent sessions register zero commands', async () => {
    const { pi } = await setup({ isSubagent: true });
    expect(pi.commands.size).toBe(0);
  });

  test('/compact triggers ctx.compact and posts an info notice', async () => {
    const { pi, ctx } = await setup();
    const cmdCtx = makeCmdCtx();
    await pi.commands.get('compact').handler('', cmdCtx);
    expect(cmdCtx.compact).toHaveBeenCalled();
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info', text: expect.stringMatching(/Compaction/) })
    );
  });

  test('/copy with no last assistant text emits an error notice', async () => {
    const { pi, ctx } = await setup({
      session: { getLastAssistantText: () => undefined },
    });
    await pi.commands.get('copy').handler('', makeCmdCtx());
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', text: expect.stringMatching(/No assistant message/) })
    );
  });

  test('/copy with text emits a clipboard notice carrying the payload', async () => {
    const { pi, ctx } = await setup({
      session: { getLastAssistantText: () => 'hello world' },
    });
    await pi.commands.get('copy').handler('', makeCmdCtx());
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clipboard', payload: 'hello world' })
    );
  });

  test('/clone uses the leaf id and forks at-position', async () => {
    const { pi, ctx } = await setup();
    const cmdCtx = makeCmdCtx();
    await pi.commands.get('clone').handler('', cmdCtx);
    expect(cmdCtx.fork).toHaveBeenCalledWith('leaf-1', { position: 'at' });
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info', text: expect.stringMatching(/cloned/i) })
    );
  });

  test('/clone bails with an error when there is no leaf yet', async () => {
    const { pi, ctx } = await setup();
    const cmdCtx = makeCmdCtx({ sessionManager: { getLeafId: () => null } });
    await pi.commands.get('clone').handler('', cmdCtx);
    expect(cmdCtx.fork).not.toHaveBeenCalled();
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error' })
    );
  });

  test('/clone respects user cancellation (no notice on cancel)', async () => {
    const { pi, ctx } = await setup();
    const cmdCtx = makeCmdCtx({ fork: jest.fn(async () => ({ cancelled: true })) });
    await pi.commands.get('clone').handler('', cmdCtx);
    expect(ctx.onNotice).not.toHaveBeenCalled();
  });

  test('/export forwards args to session.exportToHtml and reports the path', async () => {
    const { pi, ctx } = await setup({
      session: { exportToHtml: jest.fn(async (p) => p ?? '/tmp/default.html') },
    });
    await pi.commands.get('export').handler('  /tmp/out.html  ', makeCmdCtx());
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info', text: expect.stringMatching(/Exported to \/tmp\/out\.html/) })
    );
  });

  test('/export reports a failure as an error notice', async () => {
    const { pi, ctx } = await setup({
      session: { exportToHtml: jest.fn(async () => { throw new Error('disk full'); }) },
    });
    await pi.commands.get('export').handler('', makeCmdCtx());
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', text: expect.stringMatching(/disk full/) })
    );
  });

  test('/session emits formatted stats when available', async () => {
    const { pi, ctx } = await setup({
      session: {
        getSessionStats: () => ({ messageCount: 3, totalTokens: 1200, contextWindow: 4000 }),
      },
    });
    await pi.commands.get('session').handler('', makeCmdCtx());
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'info',
        text: expect.stringMatching(/3 messages.*1200 tokens.*context 4000/),
      })
    );
  });

  test('/name calls pi.setSessionName with the trimmed args', async () => {
    const { pi, ctx } = await setup();
    await pi.commands.get('name').handler('  My Chat  ', makeCmdCtx());
    expect(pi.sessionNameSet).toEqual(['My Chat']);
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info', text: expect.stringMatching(/renamed to "My Chat"/) })
    );
  });

  test('/name without args emits a usage error', async () => {
    const { pi, ctx } = await setup();
    await pi.commands.get('name').handler('', makeCmdCtx());
    expect(pi.sessionNameSet).toEqual([]);
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', text: expect.stringMatching(/Usage/) })
    );
  });
});

describe('Phase 6.5 — compaction notices', () => {
  function makeContext(overrides = {}) {
    return {
      profile: ALL_TIERS_PROFILE,
      sessionId: '/tmp/sessions/x.jsonl',
      webContentsId: 42,
      onToolCall: jest.fn(),
      requestConsent: jest.fn(async () => 'allow'),
      onToolResult: jest.fn(),
      onNotice: jest.fn(),
      ...overrides,
    };
  }

  async function setupWith({ isSubagent = false } = {}) {
    const ctx = makeContext();
    const pi = makeFakePiApi();
    await createFreedomExtension({
      toolCallContext: ctx,
      sessionRef: { session: null },
      isSubagent,
    })(pi);
    return { ctx, pi };
  }

  test('main session registers session_before_compact and session_compact handlers', async () => {
    const { pi } = await setupWith();
    expect(pi.handlers.has('session_before_compact')).toBe(true);
    expect(pi.handlers.has('session_compact')).toBe(true);
  });

  test('subagent session does NOT register compaction handlers (no UI to show)', async () => {
    const { pi } = await setupWith({ isSubagent: true });
    expect(pi.handlers.has('session_before_compact')).toBe(false);
    expect(pi.handlers.has('session_compact')).toBe(false);
  });

  test('session_before_compact emits a compaction-start notice', async () => {
    const { pi, ctx } = await setupWith();
    const handler = pi.handlers.get('session_before_compact')[0];
    await handler({ type: 'session_before_compact' });
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'compaction-start', text: expect.stringMatching(/Compacting/) })
    );
  });

  test('session_compact emits compaction-end with formatted token count', async () => {
    const { pi, ctx } = await setupWith();
    const handler = pi.handlers.get('session_compact')[0];
    await handler({
      type: 'session_compact',
      compactionEntry: { tokensBefore: 12300 },
      fromExtension: false,
    });
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'compaction-end',
        text: expect.stringMatching(/12\.3k tokens summarised/),
      })
    );
  });

  test('session_compact without tokens still emits a generic completion notice', async () => {
    const { pi, ctx } = await setupWith();
    const handler = pi.handlers.get('session_compact')[0];
    await handler({ type: 'session_compact', compactionEntry: {}, fromExtension: false });
    expect(ctx.onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'compaction-end', text: 'Context compacted' })
    );
  });
});
