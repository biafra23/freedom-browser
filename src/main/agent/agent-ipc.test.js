jest.mock('electron', () => {
  const handlers = new Map();
  return {
    ipcMain: {
      handle: jest.fn((channel, handler) => handlers.set(channel, handler)),
      _handlers: handlers,
    },
    app: {
      on: jest.fn(),
      getPath: jest.fn(() => '/tmp/freedom-test-userdata'),
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

jest.mock('./agent-profiles', () => ({
  getDefaultProfile: jest.fn(() => ({
    id: 'default',
    allowed_tool_tiers: [
      'local_safe',
      'local_sensitive',
      'browser_mutation',
    ],
  })),
}));

const mockCreateSession = jest.fn();
jest.mock('./pi-runtime', () => {
  const piModule = {
    SessionManager: {
      list: jest.fn(),
      open: jest.fn(),
      create: jest.fn(),
    },
  };
  return {
    createFreedomPiSession: (...args) => mockCreateSession(...args),
    getFreedomAgentDir: () => '/tmp/freedom-test-userdata/pi-agent',
    _internals: {
      loadPi: jest.fn(async () => piModule),
      _piModule: piModule,
    },
  };
});

const fs = require('node:fs');
jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);

const { ipcMain } = require('electron');
const { getVersion, listModels } = require('./ollama-meta');
const piRuntime = require('./pi-runtime');
const piModule = piRuntime._internals._piModule;
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
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeFakeSession({ promptBehavior = 'resolve', promptText = 'Hello!' } = {}) {
  let subscriber = null;
  const session = {
    subscribe: jest.fn((cb) => {
      subscriber = cb;
      return () => {
        subscriber = null;
      };
    }),
    setActiveToolsByName: jest.fn(),
    prompt: jest.fn(async () => {
      // Drive a couple of text deltas + agent_end through the subscriber.
      for (const ch of promptText) {
        subscriber?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: ch },
        });
      }
      subscriber?.({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: promptText }],
            usage: { input: 5, output: 6, totalTokens: 11 },
            stopReason: 'stop',
          },
        ],
      });
      if (promptBehavior === 'reject') throw new Error('prompt boom');
      if (promptBehavior === 'hang') await new Promise(() => {});
    }),
    abort: jest.fn(async () => undefined),
    dispose: jest.fn(),
  };
  return session;
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
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.AGENT_SESSION_LIST, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.AGENT_SESSION_GET, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(
      IPC.AGENT_SESSION_GET_RECENT,
      expect.any(Function)
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.AGENT_SESSION_CREATE, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.AGENT_SESSION_RENAME, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.AGENT_SESSION_DELETE, expect.any(Function));
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
  });

  test('returns running:false when version check fails', async () => {
    getVersion.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await _internals.handleStatus();
    expect(result.running).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  test('still reports running:true when listModels fails', async () => {
    getVersion.mockResolvedValue({ version: '0.23.2' });
    listModels.mockRejectedValue(new Error('boom'));
    const result = await _internals.handleStatus();
    expect(result.running).toBe(true);
    expect(result.models).toEqual([]);
  });
});

describe('startChatStream + pumpChat', () => {
  test('rejects missing fields with a structured error', async () => {
    const sender = makeSender();
    expect(
      await _internals.startChatStream(makeEvent(sender), {
        model: '',
        prompt: 'hi',
        sessionPath: '/tmp/s.jsonl',
      })
    ).toEqual({ error: expect.stringMatching(/model is required/) });
    expect(
      await _internals.startChatStream(makeEvent(sender), {
        model: 'm',
        prompt: '',
        sessionPath: '/tmp/s.jsonl',
      })
    ).toEqual({ error: expect.stringMatching(/prompt is required/) });
    expect(
      await _internals.startChatStream(makeEvent(sender), {
        model: 'm',
        prompt: 'hi',
        sessionPath: '',
      })
    ).toEqual({ error: expect.stringMatching(/sessionPath is required/) });
    expect(_internals.activeStreams.size).toBe(0);
  });

  test('streams text deltas and a terminal done event with stats', async () => {
    const session = makeFakeSession({ promptText: 'Hi!' });
    const dispose = jest.fn();
    mockCreateSession.mockResolvedValueOnce({ session, dispose, modelId: 'gemma4:e2b' });

    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      prompt: 'say hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();

    const chunkText = sender.send.mock.calls
      .filter((c) => c[0] === IPC.AGENT_CHAT_CHUNK)
      .map((c) => c[1].content)
      .join('');
    expect(chunkText).toBe('Hi!');

    const doneCalls = sender.send.mock.calls.filter((c) => c[0] === IPC.AGENT_CHAT_DONE);
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][1].fullContent).toBe('Hi!');
    expect(doneCalls[0][1].stats.usage.totalTokens).toBe(11);
    expect(doneCalls[0][1].stats.finishReason).toBe('stop');
    expect(dispose).toHaveBeenCalled();
    expect(_internals.activeStreams.size).toBe(0);
  });

  test('emits error done event when createFreedomPiSession throws', async () => {
    mockCreateSession.mockRejectedValueOnce(new Error('no model pulled'));
    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      prompt: 'hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();
    const done = sender.send.mock.calls.find((c) => c[0] === IPC.AGENT_CHAT_DONE);
    expect(done[1].error).toMatch(/no model pulled/);
    expect(_internals.activeStreams.size).toBe(0);
  });

  test('emits error done event when prompt rejects unexpectedly', async () => {
    const session = makeFakeSession({ promptBehavior: 'reject' });
    mockCreateSession.mockResolvedValueOnce({
      session,
      dispose: jest.fn(),
      modelId: 'm',
    });
    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      prompt: 'hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();
    const done = sender.send.mock.calls.find((c) => c[0] === IPC.AGENT_CHAT_DONE);
    expect(done[1].error).toMatch(/prompt boom/);
  });
});

describe('cancelChatStream', () => {
  test('returns cancelled:false for unknown streamId', async () => {
    const result = await _internals.cancelChatStream(null, { streamId: 'unknown' });
    expect(result.cancelled).toBe(false);
  });

  test('aborts the Pi session and emits cancelled:true', async () => {
    const session = makeFakeSession({ promptBehavior: 'hang' });
    const dispose = jest.fn();
    mockCreateSession.mockResolvedValueOnce({ session, dispose, modelId: 'm' });

    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      prompt: 'hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();
    expect(_internals.activeStreams.has(streamId)).toBe(true);

    const result = await _internals.cancelChatStream(null, { streamId });
    expect(result.cancelled).toBe(true);
    expect(session.abort).toHaveBeenCalled();
  });
});

describe('dropStreamsForSender', () => {
  test('aborts and removes streams owned by the given sender', async () => {
    const sessionA = makeFakeSession({ promptBehavior: 'hang' });
    const sessionB = makeFakeSession({ promptBehavior: 'hang' });
    mockCreateSession
      .mockResolvedValueOnce({ session: sessionA, dispose: jest.fn(), modelId: 'm' })
      .mockResolvedValueOnce({ session: sessionB, dispose: jest.fn(), modelId: 'm' });

    const senderA = makeSender({ id: 100 });
    const senderB = makeSender({ id: 200 });
    const { streamId: a } = await _internals.startChatStream(makeEvent(senderA), {
      model: 'm',
      prompt: 'x',
      sessionPath: '/tmp/a.jsonl',
    });
    const { streamId: b } = await _internals.startChatStream(makeEvent(senderB), {
      model: 'm',
      prompt: 'y',
      sessionPath: '/tmp/b.jsonl',
    });
    await flushAsyncQueue();

    _internals.dropStreamsForSender(100);
    expect(_internals.activeStreams.has(a)).toBe(false);
    expect(_internals.activeStreams.has(b)).toBe(true);
    expect(sessionA.abort).toHaveBeenCalled();
    expect(sessionB.abort).not.toHaveBeenCalled();
  });
});

describe('handleConsentResponse', () => {
  test('returns ok:false for unknown streamId', () => {
    const result = _internals.handleConsentResponse(null, {
      streamId: 'nope',
      callId: 'y',
      decision: 'allow',
    });
    expect(result.ok).toBe(false);
  });

  test('returns ok:false when there is no pending consent for the callId', async () => {
    const session = makeFakeSession({ promptBehavior: 'hang' });
    mockCreateSession.mockResolvedValueOnce({ session, dispose: jest.fn(), modelId: 'm' });
    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      prompt: 'hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();
    const result = _internals.handleConsentResponse(null, {
      streamId,
      callId: 'never-existed',
      decision: 'allow',
    });
    expect(result.ok).toBe(false);
  });

  test('resolves the pending consent Promise with the user choice', async () => {
    const session = makeFakeSession({ promptBehavior: 'hang' });
    mockCreateSession.mockResolvedValueOnce({ session, dispose: jest.fn(), modelId: 'm' });
    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      prompt: 'hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();

    // Fish out the toolCallContext that was passed to createFreedomPiSession,
    // simulate a `requestConsent` call from the extension, then resolve it.
    const toolCallContext = mockCreateSession.mock.calls[0][0].toolCallContext;
    expect(toolCallContext).toBeDefined();

    const consentPromise = toolCallContext.requestConsent({
      callId: 'c1',
      name: 'navigate',
      tier: 'browser_mutation',
      args: { url: 'https://x' },
      description: 'Navigate',
    });

    const result = _internals.handleConsentResponse(null, {
      streamId,
      callId: 'c1',
      decision: 'allow-session',
    });
    expect(result.ok).toBe(true);
    await expect(consentPromise).resolves.toBe('allow-session');
  });

  test('drops invalid decision strings down to deny', async () => {
    const session = makeFakeSession({ promptBehavior: 'hang' });
    mockCreateSession.mockResolvedValueOnce({ session, dispose: jest.fn(), modelId: 'm' });
    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      prompt: 'hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();
    const toolCallContext = mockCreateSession.mock.calls[0][0].toolCallContext;
    const consentPromise = toolCallContext.requestConsent({
      callId: 'c1',
      name: 'navigate',
      tier: 'browser_mutation',
      args: {},
      description: 'Navigate',
    });
    _internals.handleConsentResponse(null, {
      streamId,
      callId: 'c1',
      decision: 'unknown-string',
    });
    await expect(consentPromise).resolves.toBe('deny');
  });
});

describe('toolCallContext (Phase 3 wiring)', () => {
  test('builds a context that emits AGENT_CHAT_TOOL_CALL via sender.send', async () => {
    const session = makeFakeSession({ promptBehavior: 'hang' });
    mockCreateSession.mockResolvedValueOnce({ session, dispose: jest.fn(), modelId: 'm' });
    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      prompt: 'hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();
    const toolCallContext = mockCreateSession.mock.calls[0][0].toolCallContext;
    toolCallContext.onToolCall({
      callId: 'c1',
      name: 'navigate',
      tier: 'browser_mutation',
      args: { url: 'https://x' },
    });
    const sends = sender.send.mock.calls.filter((c) => c[0] === IPC.AGENT_CHAT_TOOL_CALL);
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual(
      expect.objectContaining({ callId: 'c1', name: 'navigate', tier: 'browser_mutation' })
    );
  });

  test('onToolResult pushes status onto matching tool-call record + emits IPC', async () => {
    const session = makeFakeSession({ promptBehavior: 'hang' });
    mockCreateSession.mockResolvedValueOnce({ session, dispose: jest.fn(), modelId: 'm' });
    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      prompt: 'hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();
    const toolCallContext = mockCreateSession.mock.calls[0][0].toolCallContext;
    toolCallContext.onToolCall({
      callId: 'c1',
      name: 'navigate',
      tier: 'browser_mutation',
      args: {},
    });
    toolCallContext.onToolResult({
      callId: 'c1',
      status: 'allowed',
      result: { url: 'https://x' },
    });
    const ctx = _internals.activeStreams.get(streamId);
    expect(ctx.toolCalls[0]).toEqual(
      expect.objectContaining({ id: 'c1', status: 'allowed', result: { url: 'https://x' } })
    );
    const sends = sender.send.mock.calls.filter(
      (c) => c[0] === IPC.AGENT_CHAT_TOOL_RESULT
    );
    expect(sends[0][1]).toEqual(
      expect.objectContaining({ callId: 'c1', status: 'allowed' })
    );
  });

  test('dropStream resolves outstanding consents as deny', async () => {
    const session = makeFakeSession({ promptBehavior: 'hang' });
    mockCreateSession.mockResolvedValueOnce({ session, dispose: jest.fn(), modelId: 'm' });
    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      prompt: 'hi',
      sessionPath: '/tmp/s.jsonl',
    });
    await flushAsyncQueue();
    const toolCallContext = mockCreateSession.mock.calls[0][0].toolCallContext;
    const consentPromise = toolCallContext.requestConsent({
      callId: 'c1',
      name: 'navigate',
      tier: 'browser_mutation',
      args: {},
      description: 'Navigate',
    });
    _internals.dropStreamsForSender(sender.id);
    await expect(consentPromise).resolves.toBe('deny');
    expect(_internals.activeStreams.has(streamId)).toBe(false);
  });
});

describe('listSessions', () => {
  test('maps SessionInfo[] to renderer view-model and sorts by modified desc', async () => {
    const newer = new Date('2026-05-08T12:00:00Z');
    const older = new Date('2026-05-07T12:00:00Z');
    piModule.SessionManager.list.mockResolvedValue([
      {
        path: '/tmp/older.jsonl',
        id: 'a',
        cwd: '/cwd',
        name: 'Older',
        created: older,
        modified: older,
        messageCount: 4,
        firstMessage: 'first',
        allMessagesText: '',
      },
      {
        path: '/tmp/newer.jsonl',
        id: 'b',
        cwd: '/cwd',
        name: undefined,
        created: newer,
        modified: newer,
        messageCount: 1,
        firstMessage: 'newest',
        allMessagesText: '',
      },
    ]);
    const list = await _internals.listSessions(50);
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('/tmp/newer.jsonl');
    expect(list[0].title).toBe('newest');
    expect(list[0].updated_at).toBe(newer.getTime());
    expect(list[1].id).toBe('/tmp/older.jsonl');
    expect(list[1].title).toBe('Older');
  });

  test('honours the limit parameter', async () => {
    const dates = [...Array(5)].map((_, i) => new Date(`2026-05-${i + 1}T00:00:00Z`));
    piModule.SessionManager.list.mockResolvedValue(
      dates.map((d, i) => ({
        path: `/tmp/${i}.jsonl`,
        id: String(i),
        cwd: '',
        created: d,
        modified: d,
        messageCount: 0,
        firstMessage: '',
        allMessagesText: '',
      }))
    );
    const list = await _internals.listSessions(2);
    expect(list).toHaveLength(2);
  });
});

describe('getSession', () => {
  test('returns null for missing path', async () => {
    expect(await _internals.getSession(undefined)).toBeNull();
  });

  test('returns null when SessionManager.open throws', async () => {
    piModule.SessionManager.open.mockImplementationOnce(() => {
      throw new Error('not found');
    });
    expect(await _internals.getSession('/tmp/missing.jsonl')).toBeNull();
  });

  test('returns metadata + Pi messages for a valid session', async () => {
    piModule.SessionManager.open.mockReturnValueOnce({
      getEntries: () => [
        {
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-05-08T10:00:00Z',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'message',
          id: 'm2',
          parentId: 'm1',
          timestamp: '2026-05-08T10:00:05Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
        },
      ],
      getSessionName: () => 'My Chat',
      getHeader: () => ({ timestamp: '2026-05-08T10:00:00Z' }),
    });

    const session = await _internals.getSession('/tmp/x.jsonl');
    expect(session.id).toBe('/tmp/x.jsonl');
    expect(session.title).toBe('My Chat');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(session.created_at).toBe(Date.parse('2026-05-08T10:00:00Z'));
    expect(session.updated_at).toBe(Date.parse('2026-05-08T10:00:05Z'));
  });

  test('falls back to first user message text when no name is set', async () => {
    piModule.SessionManager.open.mockReturnValueOnce({
      getEntries: () => [
        {
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-05-08T10:00:00Z',
          message: { role: 'user', content: 'first turn text' },
        },
      ],
      getSessionName: () => undefined,
      getHeader: () => ({ timestamp: '2026-05-08T10:00:00Z' }),
    });
    const session = await _internals.getSession('/tmp/x.jsonl');
    expect(session.title).toBe('first turn text');
  });
});

describe('createSession', () => {
  test('creates the session file and returns metadata', async () => {
    const headerTs = '2026-05-08T10:00:00Z';
    const sm = {
      appendSessionInfo: jest.fn(),
      getSessionFile: () => '/tmp/sessions/abc.jsonl',
      getHeader: () => ({ timestamp: headerTs }),
    };
    piModule.SessionManager.create.mockReturnValueOnce(sm);

    const result = await _internals.createSession({ title: 'My new chat' });
    expect(result.id).toBe('/tmp/sessions/abc.jsonl');
    expect(result.title).toBe('My new chat');
    expect(result.created_at).toBe(Date.parse(headerTs));
    expect(sm.appendSessionInfo).toHaveBeenCalledWith('My new chat');
  });

  test('does not call appendSessionInfo when no title is supplied', async () => {
    const sm = {
      appendSessionInfo: jest.fn(),
      getSessionFile: () => '/tmp/sessions/abc.jsonl',
      getHeader: () => ({ timestamp: '2026-05-08T10:00:00Z' }),
    };
    piModule.SessionManager.create.mockReturnValueOnce(sm);
    const result = await _internals.createSession({});
    expect(sm.appendSessionInfo).not.toHaveBeenCalled();
    expect(result.title).toBeNull();
  });

  test('throws if SessionManager.create returns no sessionFile', async () => {
    piModule.SessionManager.create.mockReturnValueOnce({
      appendSessionInfo: jest.fn(),
      getSessionFile: () => undefined,
      getHeader: () => null,
    });
    await expect(_internals.createSession({})).rejects.toThrow(/session file/);
  });
});

describe('renameSession', () => {
  test('appends a session_info entry and returns true on success', async () => {
    const sm = { appendSessionInfo: jest.fn() };
    piModule.SessionManager.open.mockReturnValueOnce(sm);
    expect(await _internals.renameSession('/tmp/x.jsonl', 'New Name')).toBe(true);
    expect(sm.appendSessionInfo).toHaveBeenCalledWith('New Name');
  });

  test('returns false when path or title is missing', async () => {
    expect(await _internals.renameSession('', 'x')).toBe(false);
    expect(await _internals.renameSession('/tmp/x.jsonl', '')).toBe(false);
  });

  test('returns false when SessionManager.open throws', async () => {
    piModule.SessionManager.open.mockImplementationOnce(() => {
      throw new Error('missing');
    });
    expect(await _internals.renameSession('/tmp/missing.jsonl', 'X')).toBe(false);
  });
});

describe('deleteSession', () => {
  test('returns false when path is missing', () => {
    expect(_internals.deleteSession()).toBe(false);
    expect(_internals.deleteSession('')).toBe(false);
  });

  test('unlinks the file and returns true on success', () => {
    expect(_internals.deleteSession('/tmp/x.jsonl')).toBe(true);
  });

  test('returns false when unlink throws', () => {
    fs.unlinkSync.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(_internals.deleteSession('/tmp/missing.jsonl')).toBe(false);
  });
});
