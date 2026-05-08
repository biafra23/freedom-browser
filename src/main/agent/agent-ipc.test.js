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

jest.mock('./ollama-client', () => ({
  getVersion: jest.fn(),
  listModels: jest.fn(),
  streamChat: jest.fn(),
}));

const { ipcMain } = require('electron');
const { getVersion, listModels, streamChat } = require('./ollama-client');
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
  // Let microtasks/macrotasks resolve so the `pumpChat` background task
  // finishes before we assert on the sender's emitted messages.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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
      models: [
        { name: 'gemma4:e2b', size: 7200000000, modified_at: '2026-05-08T12:05:00Z' },
      ],
    });

    const result = await _internals.handleStatus();
    expect(result.running).toBe(true);
    expect(result.version).toBe('0.23.2');
    expect(result.models).toHaveLength(1);
    expect(result.models[0].name).toBe('gemma4:e2b');
  });

  test('returns running:false when daemon is unreachable', async () => {
    getVersion.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await _internals.handleStatus();
    expect(result.running).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
    expect(result.models).toEqual([]);
  });
});

describe('startChatStream + pumpChat', () => {
  test('streams chunks back to the sender and emits a final done event', async () => {
    streamChat.mockImplementation(async function* () {
      yield { message: { content: 'Hel' }, done: false };
      yield { message: { content: 'lo' }, done: false };
      yield { message: { content: '!' }, done: true, eval_count: 3 };
    });

    const sender = makeSender();
    const result = await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(typeof result.streamId).toBe('string');
    await flushAsyncQueue();

    const chunkCalls = sender.send.mock.calls.filter(
      (c) => c[0] === IPC.AGENT_CHAT_CHUNK
    );
    expect(chunkCalls).toHaveLength(3);
    expect(chunkCalls.map((c) => c[1].content).join('')).toBe('Hello!');

    const doneCalls = sender.send.mock.calls.filter((c) => c[0] === IPC.AGENT_CHAT_DONE);
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][1].fullContent).toBe('Hello!');
    expect(doneCalls[0][1].stats.eval_count).toBe(3);
  });

  test('rejects empty messages and returns an error object', async () => {
    const sender = makeSender();
    const result = await _internals.startChatStream(makeEvent(sender), {
      model: 'gemma4:e2b',
      messages: [],
    });
    expect(result).toEqual({ error: expect.stringMatching(/messages/) });
    expect(streamChat).not.toHaveBeenCalled();
  });

  test('rejects missing model and returns an error object', async () => {
    const sender = makeSender();
    const result = await _internals.startChatStream(makeEvent(sender), {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toEqual({ error: expect.stringMatching(/model/) });
    expect(streamChat).not.toHaveBeenCalled();
  });

  test('surfaces upstream errors via a done event with `error`', async () => {
    streamChat.mockImplementation(async function* () {
      yield { message: { content: 'partial' }, done: false };
      throw new Error('boom');
    });

    const sender = makeSender();
    await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await flushAsyncQueue();

    const doneCalls = sender.send.mock.calls.filter((c) => c[0] === IPC.AGENT_CHAT_DONE);
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][1].error).toBe('boom');
    expect(doneCalls[0][1].fullContent).toBe('partial');
  });

  test('skips sending chunks if the sender is destroyed mid-stream', async () => {
    const sender = makeSender();
    sender.isDestroyed = jest
      .fn()
      .mockReturnValueOnce(false) // first chunk OK
      .mockReturnValue(true); // subsequent calls report destroyed

    streamChat.mockImplementation(async function* () {
      yield { message: { content: 'A' }, done: false };
      yield { message: { content: 'B' }, done: true };
    });

    await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await flushAsyncQueue();

    // Only the first chunk should have been sent; the done event is also
    // suppressed because isDestroyed reports true by then.
    expect(sender.send.mock.calls.length).toBe(1);
    expect(sender.send.mock.calls[0][0]).toBe(IPC.AGENT_CHAT_CHUNK);
  });
});

describe('cancelChatStream', () => {
  test('aborts the controller and removes the stream', async () => {
    let abortedSignal = false;
    streamChat.mockImplementation(async function* (_req, opts) {
      opts.signal.addEventListener('abort', () => {
        abortedSignal = true;
      });
      yield { message: { content: 'A' }, done: false };
      // Block forever-ish until cancelled — simulate by yielding until aborted.
      while (!opts.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const sender = makeSender();
    const { streamId } = await _internals.startChatStream(makeEvent(sender), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // Let the first chunk land before cancelling.
    await flushAsyncQueue();

    const result = _internals.cancelChatStream(null, { streamId });
    expect(result).toEqual({ cancelled: true });
    expect(_internals.activeStreams.has(streamId)).toBe(false);

    await flushAsyncQueue();
    expect(abortedSignal).toBe(true);
  });

  test('returns cancelled:false for unknown streamId', () => {
    const result = _internals.cancelChatStream(null, { streamId: 'nope' });
    expect(result).toEqual({ cancelled: false });
  });
});

describe('dropStreamsForSender', () => {
  test('aborts in-flight streams owned by a destroyed renderer', () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    _internals.activeStreams.set('a', { controller: controllerA, senderId: 1 });
    _internals.activeStreams.set('b', { controller: controllerB, senderId: 2 });

    _internals.dropStreamsForSender(1);

    expect(_internals.activeStreams.has('a')).toBe(false);
    expect(_internals.activeStreams.has('b')).toBe(true);
    expect(controllerA.signal.aborted).toBe(true);
    expect(controllerB.signal.aborted).toBe(false);
  });
});
