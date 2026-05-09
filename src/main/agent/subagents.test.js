jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const log = require('../logger');
const subagents = require('./subagents');
const {
  SUBAGENT_DEFINITIONS,
  SUBAGENT_IDS,
  getSubagentDefinition,
  listSubagents,
  runSubagent,
  _internals,
} = subagents;
const { TIERS } = require('./tool-tiers');

beforeEach(() => {
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});

describe('SUBAGENT_DEFINITIONS', () => {
  test('ships the three v1 subagents', () => {
    expect([...SUBAGENT_IDS].sort()).toEqual(
      ['extract_info', 'research_topic', 'summarize_current_page'].sort()
    );
  });

  test('every definition has the required fields', () => {
    for (const def of Object.values(SUBAGENT_DEFINITIONS)) {
      expect(typeof def.id).toBe('string');
      expect(typeof def.name).toBe('string');
      expect(typeof def.description).toBe('string');
      expect(typeof def.systemPrompt).toBe('string');
      expect(def.systemPrompt.length).toBeGreaterThan(40);
      expect(Array.isArray(def.allowedToolTiers)).toBe(true);
      expect(def.allowedToolTiers.length).toBeGreaterThan(0);
    }
  });

  test('summarize_current_page is single-shot read-only', () => {
    expect(SUBAGENT_DEFINITIONS.summarize_current_page.allowedToolTiers).toEqual([
      TIERS.LOCAL_SENSITIVE,
    ]);
  });

  test('research_topic gets browser-mutation tier (it navigates / clicks)', () => {
    expect(SUBAGENT_DEFINITIONS.research_topic.allowedToolTiers).toEqual(
      expect.arrayContaining([TIERS.LOCAL_SENSITIVE, TIERS.BROWSER_MUTATION])
    );
  });
});

describe('getSubagentDefinition', () => {
  test('returns the definition for a known id', () => {
    expect(getSubagentDefinition('summarize_current_page')).toBe(
      SUBAGENT_DEFINITIONS.summarize_current_page
    );
  });

  test('returns null for an unknown id', () => {
    expect(getSubagentDefinition('nope')).toBeNull();
  });
});

describe('listSubagents', () => {
  test('returns id+name+description tuples for the registry', () => {
    const list = listSubagents();
    expect(list).toHaveLength(SUBAGENT_IDS.length);
    for (const item of list) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.description).toBe('string');
    }
  });
});

describe('makeSubagentToolCallContext', () => {
  test('shares parent sessionId so session-grants carry over', () => {
    const parentToolCallContext = {
      sessionId: '/tmp/parent.jsonl',
      webContentsId: 99,
      requestConsent: jest.fn(async () => 'allow'),
    };
    const subCtx = _internals.makeSubagentToolCallContext({
      parentToolCallContext,
      subagentDef: SUBAGENT_DEFINITIONS.summarize_current_page,
    });
    expect(subCtx.sessionId).toBe('/tmp/parent.jsonl');
    expect(subCtx.webContentsId).toBe(99);
  });

  test('builds a profile from the subagent allowedToolTiers', () => {
    const subCtx = _internals.makeSubagentToolCallContext({
      parentToolCallContext: { sessionId: 's', webContentsId: 1, requestConsent: jest.fn() },
      subagentDef: SUBAGENT_DEFINITIONS.research_topic,
    });
    expect(subCtx.profile.allowed_tool_tiers).toEqual(
      expect.arrayContaining([TIERS.LOCAL_SENSITIVE, TIERS.BROWSER_MUTATION])
    );
  });

  test('forwards consent to parent with the subagent name prefixed in description', async () => {
    const requestConsent = jest.fn(async () => 'allow');
    const subCtx = _internals.makeSubagentToolCallContext({
      parentToolCallContext: { sessionId: 's', webContentsId: 1, requestConsent },
      subagentDef: SUBAGENT_DEFINITIONS.research_topic,
    });
    await subCtx.requestConsent({
      callId: 'c1',
      name: 'navigate',
      tier: TIERS.BROWSER_MUTATION,
      args: { url: 'https://x' },
      description: 'navigate to https://x',
    });
    expect(requestConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'c1',
        description: expect.stringContaining('Research a topic'),
      })
    );
  });

  test('inner onToolCall / onToolResult log only — they do not surface in main chat', () => {
    const subCtx = _internals.makeSubagentToolCallContext({
      parentToolCallContext: { sessionId: 's', webContentsId: 1, requestConsent: jest.fn() },
      subagentDef: SUBAGENT_DEFINITIONS.summarize_current_page,
    });
    expect(typeof subCtx.onToolCall).toBe('function');
    expect(typeof subCtx.onToolResult).toBe('function');
    subCtx.onToolCall({ name: 'read_current_tab' });
    subCtx.onToolResult({ callId: 'c1', status: 'allowed' });
    // No throw, and they log via our mocked logger.
    expect(log.info).toHaveBeenCalled();
  });
});

describe('runSubagent', () => {
  function makeFakeChildSession({ assistantText = 'subagent says hi' } = {}) {
    let subscriber = null;
    return {
      subscribe: jest.fn((cb) => {
        subscriber = cb;
        return () => {
          subscriber = null;
        };
      }),
      prompt: jest.fn(async () => {
        subscriber?.({ type: 'turn_end' });
        subscriber?.({
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: assistantText }],
            },
          ],
        });
      }),
      abort: jest.fn(),
      dispose: jest.fn(),
    };
  }

  test('throws on unknown subagent id', async () => {
    await expect(
      runSubagent({
        subagentId: 'nope',
        prompt: 'hi',
        parentToolCallContext: { sessionId: 's', webContentsId: 1, requestConsent: jest.fn() },
        modelId: 'gemma4:e2b',
        agentDir: '/tmp/x',
        createFreedomPiSession: jest.fn(),
      })
    ).rejects.toThrow(/unknown subagent/);
  });

  test('throws on empty prompt', async () => {
    await expect(
      runSubagent({
        subagentId: 'summarize_current_page',
        prompt: '',
        parentToolCallContext: { sessionId: 's', webContentsId: 1, requestConsent: jest.fn() },
        modelId: 'gemma4:e2b',
        agentDir: '/tmp/x',
        createFreedomPiSession: jest.fn(),
      })
    ).rejects.toThrow(/non-empty/);
  });

  test('spawns child session with isSubagent + overrideSystemPrompt and returns the assistant text', async () => {
    const childSession = makeFakeChildSession({ assistantText: 'A neat 3-paragraph summary.' });
    const dispose = jest.fn();
    const createFreedomPiSession = jest.fn(async () => ({ session: childSession, dispose }));

    const result = await runSubagent({
      subagentId: 'summarize_current_page',
      prompt: 'summarise this page',
      parentToolCallContext: {
        sessionId: '/tmp/parent.jsonl',
        webContentsId: 42,
        requestConsent: jest.fn(),
      },
      modelId: 'gemma4:e2b',
      agentDir: '/tmp/agentdir',
      createFreedomPiSession,
    });

    expect(createFreedomPiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: '/tmp/agentdir',
        modelId: 'gemma4:e2b',
        isSubagent: true,
        overrideSystemPrompt: SUBAGENT_DEFINITIONS.summarize_current_page.systemPrompt,
        toolCallContext: expect.objectContaining({
          sessionId: '/tmp/parent.jsonl',
          webContentsId: 42,
          profile: expect.objectContaining({
            allowed_tool_tiers: expect.arrayContaining([TIERS.LOCAL_SENSITIVE]),
          }),
        }),
      })
    );
    expect(result.text).toBe('A neat 3-paragraph summary.');
    expect(result.turnCount).toBe(1);
    expect(typeof result.durationMs).toBe('number');
    expect(dispose).toHaveBeenCalled();
  });

  test('throws "did not complete" when prompt resolves without agent_end', async () => {
    const childSession = {
      subscribe: jest.fn(() => () => {}),
      prompt: jest.fn(async () => undefined), // no events emitted
      abort: jest.fn(),
      dispose: jest.fn(),
    };
    const dispose = jest.fn();
    await expect(
      runSubagent({
        subagentId: 'summarize_current_page',
        prompt: 'summarise',
        parentToolCallContext: { sessionId: 's', webContentsId: 1, requestConsent: jest.fn() },
        modelId: 'm',
        agentDir: '/tmp/x',
        createFreedomPiSession: jest.fn(async () => ({ session: childSession, dispose })),
      })
    ).rejects.toThrow(/did not complete/);
    expect(dispose).toHaveBeenCalled();
  });

  test('throws immediately if the parent signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSubagent({
        subagentId: 'summarize_current_page',
        prompt: 'x',
        parentToolCallContext: { sessionId: 's', webContentsId: 1, requestConsent: jest.fn() },
        modelId: 'm',
        agentDir: '/tmp/x',
        createFreedomPiSession: jest.fn(),
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted before start/);
  });

  test('aborting the parent signal mid-run calls child session.abort', async () => {
    const childAbort = jest.fn(async () => undefined);
    const childSession = {
      subscribe: jest.fn(() => () => {}),
      prompt: jest.fn(async () => {
        // Yield once so the abort listener gets a chance to fire before
        // we resolve. No agent_end emitted — runSubagent will throw on
        // "did not complete" after we let it finish.
        await new Promise((r) => setImmediate(r));
      }),
      abort: childAbort,
      dispose: jest.fn(),
    };
    const controller = new AbortController();
    const promise = runSubagent({
      subagentId: 'summarize_current_page',
      prompt: 'x',
      parentToolCallContext: { sessionId: 's', webContentsId: 1, requestConsent: jest.fn() },
      modelId: 'm',
      agentDir: '/tmp/x',
      createFreedomPiSession: jest.fn(async () => ({ session: childSession, dispose: jest.fn() })),
      signal: controller.signal,
    });
    // Give runSubagent a tick to wire its listener.
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await expect(promise).rejects.toThrow(); // didn't complete (no agent_end)
    expect(childAbort).toHaveBeenCalled();
  });

  test('disposes child session even when prompt rejects', async () => {
    const childSession = {
      subscribe: jest.fn(() => () => {}),
      prompt: jest.fn(async () => {
        throw new Error('boom');
      }),
      abort: jest.fn(),
      dispose: jest.fn(),
    };
    const dispose = jest.fn();
    await expect(
      runSubagent({
        subagentId: 'summarize_current_page',
        prompt: 'summarise',
        parentToolCallContext: { sessionId: 's', webContentsId: 1, requestConsent: jest.fn() },
        modelId: 'm',
        agentDir: '/tmp/x',
        createFreedomPiSession: jest.fn(async () => ({ session: childSession, dispose })),
      })
    ).rejects.toThrow(/boom/);
    expect(dispose).toHaveBeenCalled();
  });
});
