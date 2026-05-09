jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const provider = require('./inference-provider');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeRuntime({ status = { inboxId: 'inbox-self', address: '0xSelf' } } = {}) {
  const published = [];
  const listeners = new Set();
  return {
    addMessageListener: jest.fn((fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
    publish: jest.fn(async (channelId, payload) => {
      published.push({ channelId, payload });
      return `msg-${published.length}`;
    }),
    getStatus: jest.fn(() => status),
    _published: published,
    _listeners: listeners,
  };
}

function makeFetch(handlers) {
  // handlers: { 'http://.../api/tags': () => responseLike, ... }
  return jest.fn(async (url) => {
    for (const [match, fn] of Object.entries(handlers)) {
      if (url.includes(match)) return fn();
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
}

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

function probeMessage({ requestId = 'r1', from = 'inbox-bob' } = {}) {
  return {
    channelId: 'lobby-id',
    message: {
      id: `m-${requestId}`,
      from,
      sentAt: new Date(),
      content: '...',
      parsed: { v: 1, kind: 'inference:probe', requestId, sentAt: '2026-05-10T00:00:00Z' },
    },
  };
}

function requestMessage({
  requestId = 'r1',
  model = 'gemma4:e2b',
  prompt = 'hello',
  system,
  from = 'inbox-bob',
} = {}) {
  return {
    channelId: 'lobby-id',
    message: {
      id: `m-${requestId}`,
      from,
      sentAt: new Date(),
      content: '...',
      parsed: {
        v: 1,
        kind: 'inference:request',
        requestId,
        model,
        prompt,
        ...(system ? { system } : {}),
        sentAt: '2026-05-10T00:00:00Z',
      },
    },
  };
}

function startProvider({
  enabled = true,
  runtime,
  models = [{ name: 'gemma4:e2b', size: 1234, details: { family: 'gemma' } }],
  chatContent = 'sample response',
  chatThrows = null,
  listModelsThrows = null,
} = {}) {
  const loadSettings = jest.fn(() => ({ aiSharedInferenceEnabled: enabled }));
  const fetchImpl = makeFetch({
    '/api/tags': () =>
      listModelsThrows
        ? Promise.reject(listModelsThrows)
        : jsonResponse({ models }),
    '/api/chat': () =>
      chatThrows
        ? Promise.reject(chatThrows)
        : jsonResponse({ message: { content: chatContent } }),
  });
  provider.start({
    runtime,
    loadSettings,
    getOllamaApiUrl: () => 'http://127.0.0.1:11434',
    fetchImpl,
  });
  return { loadSettings, fetchImpl };
}

beforeEach(() => {
  if (provider.isStarted()) provider.stop();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('start/stop', () => {
  test('start registers a single listener and stop unregisters it', () => {
    const runtime = makeRuntime();
    startProvider({ runtime });
    expect(runtime.addMessageListener).toHaveBeenCalledTimes(1);
    expect(runtime._listeners.size).toBe(1);
    provider.stop();
    expect(runtime._listeners.size).toBe(0);
  });

  test('start is idempotent', () => {
    const runtime = makeRuntime();
    startProvider({ runtime });
    startProvider({ runtime });
    expect(runtime.addMessageListener).toHaveBeenCalledTimes(1);
  });

  test('start throws on missing deps', () => {
    expect(() => provider.start({})).toThrow(/runtime, loadSettings, getOllamaApiUrl required/);
  });
});

// ---------------------------------------------------------------------------
// Toggle gating
// ---------------------------------------------------------------------------

describe('settings gate', () => {
  test('disabled toggle => no replies', async () => {
    const runtime = makeRuntime();
    startProvider({ runtime, enabled: false });
    await provider._internals.handleIncoming(probeMessage());
    expect(runtime.publish).not.toHaveBeenCalled();
  });

  test('toggle is read on every message (live flip)', async () => {
    const runtime = makeRuntime();
    let enabled = false;
    const fetchImpl = makeFetch({
      '/api/tags': () => jsonResponse({ models: [{ name: 'gemma4:e2b' }] }),
      '/api/chat': () => jsonResponse({ message: { content: 'ok' } }),
    });
    provider.start({
      runtime,
      loadSettings: () => ({ aiSharedInferenceEnabled: enabled }),
      getOllamaApiUrl: () => 'http://127.0.0.1:11434',
      fetchImpl,
    });

    await provider._internals.handleIncoming(probeMessage());
    expect(runtime.publish).not.toHaveBeenCalled();
    enabled = true;
    await provider._internals.handleIncoming(probeMessage());
    expect(runtime.publish).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Probe handling
// ---------------------------------------------------------------------------

describe('probe', () => {
  test('replies on the same channel with installed models', async () => {
    const runtime = makeRuntime();
    startProvider({
      runtime,
      models: [
        { name: 'gemma4:e2b', size: 100, details: { family: 'gemma' } },
        { name: 'qwen3:4b', size: 200, details: { family: 'qwen' } },
      ],
    });

    await provider._internals.handleIncoming(probeMessage({ requestId: 'p1' }));

    expect(runtime.publish).toHaveBeenCalledTimes(1);
    const [channelId, payload] = runtime.publish.mock.calls[0];
    expect(channelId).toBe('lobby-id');
    expect(payload).toMatchObject({
      v: 1,
      kind: 'inference:probe-ack',
      requestId: 'p1',
      providerInboxId: 'inbox-self',
      providerAddress: '0xSelf',
      models: [
        { name: 'gemma4:e2b', size: 100, family: 'gemma' },
        { name: 'qwen3:4b', size: 200, family: 'qwen' },
      ],
    });
  });

  test('silent if Ollama listModels fails', async () => {
    const runtime = makeRuntime();
    startProvider({ runtime, listModelsThrows: new Error('connection refused') });
    await provider._internals.handleIncoming(probeMessage());
    expect(runtime.publish).not.toHaveBeenCalled();
  });

  test('drops envelope without requestId', async () => {
    const runtime = makeRuntime();
    startProvider({ runtime });
    const msg = probeMessage();
    delete msg.message.parsed.requestId;
    await provider._internals.handleIncoming(msg);
    expect(runtime.publish).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

describe('request', () => {
  test('runs requested model and replies with content', async () => {
    const runtime = makeRuntime();
    const { fetchImpl } = startProvider({
      runtime,
      models: [{ name: 'gemma4:e2b' }],
      chatContent: 'the answer',
    });

    await provider._internals.handleIncoming(requestMessage({ requestId: 'q1' }));

    expect(runtime.publish).toHaveBeenCalledTimes(1);
    const [, payload] = runtime.publish.mock.calls[0];
    expect(payload).toMatchObject({
      kind: 'inference:response',
      requestId: 'q1',
      providerInboxId: 'inbox-self',
      model: 'gemma4:e2b',
      content: 'the answer',
      error: null,
    });
    expect(typeof payload.latencyMs).toBe('number');

    // Verify body shape sent to Ollama.
    const chatCall = fetchImpl.mock.calls.find(([u]) => u.includes('/api/chat'));
    const body = JSON.parse(chatCall[1].body);
    expect(body).toMatchObject({
      model: 'gemma4:e2b',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  test('wildcard model resolves to first installed', async () => {
    const runtime = makeRuntime();
    startProvider({
      runtime,
      models: [{ name: 'qwen3:4b' }, { name: 'gemma4:e2b' }],
    });

    await provider._internals.handleIncoming(
      requestMessage({ model: '*' })
    );

    const [, payload] = runtime.publish.mock.calls[0];
    expect(payload.model).toBe('qwen3:4b');
  });

  test('silent when requested model is not installed', async () => {
    const runtime = makeRuntime();
    startProvider({
      runtime,
      models: [{ name: 'gemma4:e2b' }],
    });
    await provider._internals.handleIncoming(
      requestMessage({ model: 'llama3:70b' })
    );
    expect(runtime.publish).not.toHaveBeenCalled();
  });

  test('silent when no models installed and wildcard requested', async () => {
    const runtime = makeRuntime();
    startProvider({ runtime, models: [] });
    await provider._internals.handleIncoming(requestMessage({ model: '*' }));
    expect(runtime.publish).not.toHaveBeenCalled();
  });

  test('Ollama chat error => response carries error field (not silent)', async () => {
    const runtime = makeRuntime();
    startProvider({
      runtime,
      chatThrows: new Error('out of memory'),
    });

    await provider._internals.handleIncoming(requestMessage({ requestId: 'q2' }));

    expect(runtime.publish).toHaveBeenCalledTimes(1);
    const [, payload] = runtime.publish.mock.calls[0];
    expect(payload).toMatchObject({
      kind: 'inference:response',
      requestId: 'q2',
      content: null,
      error: 'out of memory',
    });
  });

  test('system prompt is prepended as a system message', async () => {
    const runtime = makeRuntime();
    const { fetchImpl } = startProvider({ runtime });

    await provider._internals.handleIncoming(
      requestMessage({ system: 'you are terse' })
    );

    const chatCall = fetchImpl.mock.calls.find(([u]) => u.includes('/api/chat'));
    const body = JSON.parse(chatCall[1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'you are terse' },
      { role: 'user', content: 'hello' },
    ]);
  });

  test('drops oversized prompt (no reply)', async () => {
    const runtime = makeRuntime();
    startProvider({ runtime });
    const huge = 'x'.repeat(provider.MAX_PROMPT_BYTES + 1);
    await provider._internals.handleIncoming(requestMessage({ prompt: huge }));
    expect(runtime.publish).not.toHaveBeenCalled();
  });

  test('drops request without prompt', async () => {
    const runtime = makeRuntime();
    startProvider({ runtime });
    const msg = requestMessage();
    msg.message.parsed.prompt = '';
    await provider._internals.handleIncoming(msg);
    expect(runtime.publish).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Misc dispatch
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  test('ignores non-inference envelopes', async () => {
    const runtime = makeRuntime();
    startProvider({ runtime });
    await provider._internals.handleIncoming({
      channelId: 'c',
      message: { parsed: { kind: 'lobby:join-ack', requestId: 'x' } },
    });
    expect(runtime.publish).not.toHaveBeenCalled();
  });

  test('ignores envelope with non-string content (parsed null)', async () => {
    const runtime = makeRuntime();
    startProvider({ runtime });
    await provider._internals.handleIncoming({
      channelId: 'c',
      message: { parsed: null, content: 'not json' },
    });
    expect(runtime.publish).not.toHaveBeenCalled();
  });
});
