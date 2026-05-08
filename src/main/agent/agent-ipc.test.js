jest.mock('electron', () => {
  const handlers = new Map();
  return {
    ipcMain: {
      handle: jest.fn((channel, handler) => handlers.set(channel, handler)),
      _handlers: handlers,
    },
    app: {
      on: jest.fn(),
    },
  };
});

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('./ollama-meta', () => ({
  getVersion: jest.fn(),
  listModels: jest.fn(),
}));

jest.mock('../service-registry', () => ({
  getOllamaApiUrl: jest.fn(() => 'http://127.0.0.1:11434'),
}));

const mockTextStream = jest.fn();
jest.mock('ai', () => ({
  streamText: jest.fn((args) => mockTextStream(args)),
  tool: jest.fn((def) => def),
  stepCountIs: jest.fn((n) => ({ stopAfterSteps: n })),
}));

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(() => (modelId) => ({ modelId })),
}));

const mockListTools = jest.fn(() => []);
const mockEvaluate = jest.fn();
const mockGrantForSession = jest.fn();
jest.mock('./agent-permissions', () => ({
  listToolsForProfile: (...args) => mockListTools(...args),
  evaluate: (...args) => mockEvaluate(...args),
  grantForSession: (...args) => mockGrantForSession(...args),
}));

const mockRunTool = jest.fn();
jest.mock('./tools/registry', () => ({
  registerAll: jest.fn(),
  runTool: (...args) => mockRunTool(...args),
}));

jest.mock('./tools/browser-tools', () => ({ BROWSER_TOOLS: [] }));

const mockGetDefaultProfile = jest.fn(() => ({
  id: 'default-id',
  allowed_tool_tiers: ['local_safe', 'local_sensitive', 'browser_mutation'],
}));
const mockGetProfile = jest.fn();
jest.mock('./agent-profiles', () => ({
  getDefaultProfile: (...args) => mockGetDefaultProfile(...args),
  getProfile: (...args) => mockGetProfile(...args),
}));

const mockGetSession = jest.fn(() => null);
jest.mock('./sessions-store', () => ({
  getSession: (...args) => mockGetSession(...args),
}));

const { ipcMain } = require('electron');
const { getVersion, listModels } = require('./ollama-meta');
const IPC = require('../../shared/ipc-channels');
const { registerAgentIpc, _internals } = require('./agent-ipc');

function makeSender(overrides = {}) {
  return {
    id: 1,
    isDestroyed: jest.fn().mockReturnValue(false),
    send: jest.fn(),
    ...overrides,
  };
}

function makeEvent(sender) {
  return { sender };
}

async function flushAsyncQueue() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeStreamResult(textChunks, { finishReason = 'stop', usage = null } = {}) {
  return {
    textStream: (async function* () {
      for (const chunk of textChunks) {
        yield chunk;
      }
    })(),
    finishReason: Promise.resolve(finishReason),
    usage: Promise.resolve(usage),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _internals.activeStreams.clear();
});

describe('registerAgentIpc', () => {
  test('registers all agent IPC channels', () => {
    registerAgentIpc();
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.AGENT_STATUS, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.AGENT_CHAT_START, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.AGENT_CHAT_CANCEL, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.AGENT_CHAT_CONSENT, expect.any(Function));
  });
});

describe('handleStatus', () => {
  test('returns running:true with version + models when daemon is reachable', async () => {
    getVersion.mockResolvedValue({ version: '0.23.2' });
    listModels.mockResolvedValue({
      models: [{ name: 'gemma4:e2b', size: 4_000_000_000, modified_at: '2026-05-08T12:00:00Z' }],
    });

    const result = await _internals.handleStatus();
    expect(result.running).toBe(true);
    expect(result.version).toBe('0.23.2');
    expect(result.models).toHaveLength(1);
    expect(result.models[0].name).toBe('gemma4:e2b');
  });

  test('returns running:false when version check fails', async () => {
    getVersion.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await _internals.handleStatus();
    expect(result.running).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
    expect(result.models).toEqual([]);
  });

  test('still reports running:true when listModels fails (empty list)', async () => {
    getVersion.mockResolvedValue({ version: '0.23.2' });
    listModels.mockRejectedValue(new Error('boom'));
    const result = await _internals.handleStatus();
    expect(result.running).toBe(true);
    expect(result.models).toEqual([]);
  });
});

describe('startChatStream + pumpChat', () => {
  test('streams chunks back to the sender and emits a final done event', async () => {
    mockTextStream.mockReturnValueOnce(
      makeStreamResult(['Hel', 'lo', '!'], { usage: { totalTokens: 3 } })
    );

    const sender = makeSender();
    const result = await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(typeof result.streamId).toBe('string');
    await flushAsyncQueue();

    const chunkCalls = sender.send.mock.calls.filter((c) => c[0] === IPC.AGENT_CHAT_CHUNK);
    expect(chunkCalls.map((c) => c[1].content).join('')).toBe('Hello!');

    const doneCalls = sender.send.mock.calls.filter((c) => c[0] === IPC.AGENT_CHAT_DONE);
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][1].fullContent).toBe('Hello!');
    expect(doneCalls[0][1].stats.usage).toEqual({ totalTokens: 3 });
    expect(doneCalls[0][1].stats.finishReason).toBe('stop');
  });

  test('rejects empty model and returns an error object', async () => {
    const sender = makeSender();
    const result = await _internals.startChatStream(makeEvent(sender), {
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.error).toMatch(/model is required/);
    expect(_internals.activeStreams.size).toBe(0);
  });

  test('rejects empty messages and returns an error object', async () => {
    const sender = makeSender();
    const result = await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      messages: [],
    });
    expect(result.error).toMatch(/non-empty array/);
    expect(_internals.activeStreams.size).toBe(0);
  });

  test('emits cancelled:true when the stream is aborted mid-flight', async () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    mockTextStream.mockReturnValueOnce({
      textStream: (async function* () {
        yield 'partial';
        throw aborted;
      })(),
      finishReason: Promise.resolve('stop'),
      usage: Promise.resolve(null),
    });

    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    _internals.cancelChatStream(null, { streamId });
    await flushAsyncQueue();

    const doneCalls = sender.send.mock.calls.filter((c) => c[0] === IPC.AGENT_CHAT_DONE);
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][1].cancelled).toBe(true);
    expect(doneCalls[0][1].fullContent).toBe('partial');
  });

  test('emits error when the underlying stream rejects', async () => {
    mockTextStream.mockReturnValueOnce({
      // eslint-disable-next-line require-yield
      textStream: (async function* () {
        throw new Error('runtime exploded');
      })(),
      finishReason: Promise.resolve('stop'),
      usage: Promise.resolve(null),
    });

    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await flushAsyncQueue();

    const doneCalls = sender.send.mock.calls.filter((c) => c[0] === IPC.AGENT_CHAT_DONE);
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][1].error).toBe('runtime exploded');
  });

  test('skips sender.send when the renderer is destroyed mid-stream', async () => {
    mockTextStream.mockReturnValueOnce(makeStreamResult(['a', 'b']));
    const sender = makeSender({
      isDestroyed: jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValue(true),
    });
    await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await flushAsyncQueue();

    const chunkCalls = sender.send.mock.calls.filter((c) => c[0] === IPC.AGENT_CHAT_CHUNK);
    expect(chunkCalls.length).toBeLessThanOrEqual(1);
  });
});

describe('cancelChatStream', () => {
  test('returns cancelled:false for unknown streamId', () => {
    const result = _internals.cancelChatStream(null, { streamId: 'unknown' });
    expect(result.cancelled).toBe(false);
  });

  test('aborts and removes the stream entry for known streamId', async () => {
    mockTextStream.mockReturnValueOnce({
      // Never yields; waits forever until aborted.
      // eslint-disable-next-line require-yield
      textStream: (async function* () {
        await new Promise(() => {});
      })(),
      finishReason: Promise.resolve('stop'),
      usage: Promise.resolve(null),
    });
    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(_internals.activeStreams.has(streamId)).toBe(true);

    const result = _internals.cancelChatStream(null, { streamId });
    expect(result.cancelled).toBe(true);
    expect(_internals.activeStreams.has(streamId)).toBe(false);
  });
});

describe('dropStreamsForSender', () => {
  test('aborts all active streams owned by the given sender', async () => {
    mockTextStream.mockReturnValue({
      // eslint-disable-next-line require-yield
      textStream: (async function* () {
        await new Promise(() => {});
      })(),
      finishReason: Promise.resolve('stop'),
      usage: Promise.resolve(null),
    });
    const senderA = makeSender({ id: 100 });
    const senderB = makeSender({ id: 200 });

    const { streamId: a } = await _internals.startChatStream(makeEvent(senderA), {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });
    const { streamId: b } = await _internals.startChatStream(makeEvent(senderB), {
      model: 'm',
      messages: [{ role: 'user', content: 'y' }],
    });

    _internals.dropStreamsForSender(100);

    expect(_internals.activeStreams.has(a)).toBe(false);
    expect(_internals.activeStreams.has(b)).toBe(true);
  });
});

describe('resolveProfile', () => {
  test('returns the default profile when sessionId is null', () => {
    const profile = _internals.resolveProfile(null);
    expect(profile.id).toBe('default-id');
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  test('returns the default profile when the session has no agent_id', () => {
    mockGetSession.mockReturnValueOnce({ id: 's1', agent_id: null });
    const profile = _internals.resolveProfile('s1');
    expect(profile.id).toBe('default-id');
  });

  test('returns the linked profile when the session has an agent_id', () => {
    mockGetSession.mockReturnValueOnce({ id: 's1', agent_id: 'profile-x' });
    mockGetProfile.mockReturnValueOnce({ id: 'profile-x', allowed_tool_tiers: [] });
    const profile = _internals.resolveProfile('s1');
    expect(profile.id).toBe('profile-x');
  });

  test('falls back to default when the linked profile is missing', () => {
    mockGetSession.mockReturnValueOnce({ id: 's1', agent_id: 'gone' });
    mockGetProfile.mockReturnValueOnce(null);
    const profile = _internals.resolveProfile('s1');
    expect(profile.id).toBe('default-id');
  });
});

describe('tool wiring', () => {
  function setupSingleTool(toolDef) {
    mockListTools.mockReturnValue([toolDef]);
    mockEvaluate.mockReturnValue({ decision: 'allow' });
    mockRunTool.mockResolvedValue({ ok: true });
  }

  test('builds the tools list for the resolved profile and passes to streamText', async () => {
    const toolDef = {
      name: 'noop',
      description: 'd',
      tier: 'local_safe',
      inputSchema: { parse: (x) => x },
      execute: jest.fn(),
    };
    setupSingleTool(toolDef);
    mockTextStream.mockReturnValueOnce(makeStreamResult([], { usage: null }));

    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await flushAsyncQueue();

    expect(mockListTools).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'default-id' })
    );
    const callArgs = mockTextStream.mock.calls[0][0];
    expect(Object.keys(callArgs.tools)).toEqual(['noop']);
    expect(callArgs.stopWhen).toEqual({ stopAfterSteps: 8 });
  });

  test('wrapped execute streams tool-call event, runs the tool, streams result', async () => {
    const toolDef = {
      name: 'read_current_tab',
      description: 'Reads the page',
      tier: 'local_safe',
      inputSchema: { parse: (x) => x },
      execute: jest.fn(),
    };
    setupSingleTool(toolDef);
    mockRunTool.mockResolvedValueOnce({ text: 'hello world' });

    let capturedExecute;
    mockTextStream.mockImplementationOnce((args) => {
      capturedExecute = args.tools.read_current_tab.execute;
      return makeStreamResult([], { usage: null });
    });

    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      activeWebContentsId: 42,
    });
    await flushAsyncQueue();

    const result = await capturedExecute({});

    expect(mockRunTool).toHaveBeenCalledWith(
      'read_current_tab',
      {},
      expect.objectContaining({ webContentsId: 42 })
    );
    expect(result).toEqual({ text: 'hello world' });

    const toolCallSends = sender.send.mock.calls.filter(
      (c) => c[0] === IPC.AGENT_CHAT_TOOL_CALL
    );
    expect(toolCallSends).toHaveLength(1);
    expect(toolCallSends[0][1].name).toBe('read_current_tab');

    const resultSends = sender.send.mock.calls.filter(
      (c) => c[0] === IPC.AGENT_CHAT_TOOL_RESULT
    );
    expect(resultSends).toHaveLength(1);
    expect(resultSends[0][1].status).toBe('allowed');
  });

  test('blocked decision returns an error result without running the tool', async () => {
    const toolDef = {
      name: 'pay',
      description: 'd',
      tier: 'money',
      inputSchema: { parse: (x) => x },
      execute: jest.fn(),
    };
    mockListTools.mockReturnValue([toolDef]);
    mockEvaluate.mockReturnValue({ decision: 'block', reason: 'tier blocked' });

    let capturedExecute;
    mockTextStream.mockImplementationOnce((args) => {
      capturedExecute = args.tools.pay.execute;
      return makeStreamResult([], { usage: null });
    });

    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await flushAsyncQueue();

    const result = await capturedExecute({});
    expect(mockRunTool).not.toHaveBeenCalled();
    expect(result).toEqual({ error: 'tier blocked' });

    const resultSends = sender.send.mock.calls.filter(
      (c) => c[0] === IPC.AGENT_CHAT_TOOL_RESULT
    );
    expect(resultSends[0][1].status).toBe('blocked');
  });

  test('ask decision streams consent-request and resumes on allow', async () => {
    const toolDef = {
      name: 'click',
      description: 'd',
      tier: 'browser_mutation',
      inputSchema: { parse: (x) => x },
      execute: jest.fn(),
    };
    mockListTools.mockReturnValue([toolDef]);
    mockEvaluate.mockReturnValue({ decision: 'ask', tier: 'browser_mutation' });
    mockRunTool.mockResolvedValue({ clicked: true });

    let capturedExecute;
    mockTextStream.mockImplementationOnce((args) => {
      capturedExecute = args.tools.click.execute;
      // Hanging textStream: keeps pumpChat open so the stream entry
      // (and its pendingConsent map) is still alive when the test
      // calls handleConsentResponse below. dropStream's auto-reject
      // would otherwise rug the pending Promise out from under us.
      return {
        // eslint-disable-next-line require-yield
        textStream: (async function* () {
          await new Promise(() => {});
        })(),
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve(null),
      };
    });

    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await flushAsyncQueue();

    const executePromise = capturedExecute({ selector: '#x' });
    await flushAsyncQueue();

    const consentSend = sender.send.mock.calls.find(
      (c) => c[0] === IPC.AGENT_CHAT_CONSENT_REQUEST
    );
    expect(consentSend).toBeTruthy();
    const callId = consentSend[1].callId;

    _internals.handleConsentResponse(null, { streamId, callId, decision: 'allow' });
    const result = await executePromise;
    expect(result).toEqual({ clicked: true });
    expect(mockRunTool).toHaveBeenCalled();
  });

  test('deny decision returns error result and never runs the tool', async () => {
    const toolDef = {
      name: 'navigate',
      description: 'd',
      tier: 'browser_mutation',
      inputSchema: { parse: (x) => x },
      execute: jest.fn(),
    };
    mockListTools.mockReturnValue([toolDef]);
    mockEvaluate.mockReturnValue({ decision: 'ask', tier: 'browser_mutation' });

    let capturedExecute;
    mockTextStream.mockImplementationOnce((args) => {
      capturedExecute = args.tools.navigate.execute;
      return {
        // eslint-disable-next-line require-yield
        textStream: (async function* () {
          await new Promise(() => {});
        })(),
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve(null),
      };
    });

    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await flushAsyncQueue();

    const executePromise = capturedExecute({ url: 'https://x' });
    await flushAsyncQueue();
    const consentSend = sender.send.mock.calls.find(
      (c) => c[0] === IPC.AGENT_CHAT_CONSENT_REQUEST
    );
    _internals.handleConsentResponse(null, {
      streamId,
      callId: consentSend[1].callId,
      decision: 'deny',
    });
    const result = await executePromise;
    expect(result).toEqual({ error: 'User denied this tool call' });
    expect(mockRunTool).not.toHaveBeenCalled();
  });

  test('allow-session decision grants the tier for the session and proceeds', async () => {
    const toolDef = {
      name: 'read',
      description: 'd',
      tier: 'local_sensitive',
      inputSchema: { parse: (x) => x },
      execute: jest.fn(),
    };
    mockListTools.mockReturnValue([toolDef]);
    mockEvaluate.mockReturnValue({ decision: 'ask', tier: 'local_sensitive' });
    mockRunTool.mockResolvedValue({ text: 'x' });

    let capturedExecute;
    mockTextStream.mockImplementationOnce((args) => {
      capturedExecute = args.tools.read.execute;
      return {
        // eslint-disable-next-line require-yield
        textStream: (async function* () {
          await new Promise(() => {});
        })(),
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve(null),
      };
    });

    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'session-X',
    });
    await flushAsyncQueue();

    const executePromise = capturedExecute({});
    await flushAsyncQueue();
    const consentSend = sender.send.mock.calls.find(
      (c) => c[0] === IPC.AGENT_CHAT_CONSENT_REQUEST
    );
    _internals.handleConsentResponse(null, {
      streamId,
      callId: consentSend[1].callId,
      decision: 'allow-session',
    });
    await executePromise;

    expect(mockGrantForSession).toHaveBeenCalledWith('session-X', 'local_sensitive');
    expect(mockRunTool).toHaveBeenCalled();
  });

  test('done event includes the accumulated tool-calls', async () => {
    const toolDef = {
      name: 'noop',
      description: 'd',
      tier: 'local_safe',
      inputSchema: { parse: (x) => x },
      execute: jest.fn(),
    };
    setupSingleTool(toolDef);
    mockRunTool.mockResolvedValueOnce({ ok: true });

    let capturedExecute;
    mockTextStream.mockImplementationOnce((args) => {
      capturedExecute = args.tools.noop.execute;
      return makeStreamResult(['done'], { usage: { totalTokens: 1 } });
    });

    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await flushAsyncQueue();
    await capturedExecute({});
    await flushAsyncQueue();

    const doneCall = sender.send.mock.calls.find((c) => c[0] === IPC.AGENT_CHAT_DONE);
    expect(doneCall[1].toolCalls).toHaveLength(1);
    expect(doneCall[1].toolCalls[0]).toEqual(
      expect.objectContaining({
        name: 'noop',
        status: 'allowed',
        result: { ok: true },
      })
    );
  });
});

describe('handleConsentResponse', () => {
  test('returns ok:false for unknown streamId', () => {
    const result = _internals.handleConsentResponse(null, {
      streamId: 'nope',
      callId: 'x',
      decision: 'allow',
    });
    expect(result.ok).toBe(false);
  });
});
