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
}));

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(() => (modelId) => ({ modelId })),
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
