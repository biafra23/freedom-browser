const { createElement, createDocument } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalMarked = global.marked;
const originalDOMPurify = global.DOMPurify;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function createAgentBridge(initialStatus = { running: true, version: '0.23.2', models: [] }) {
  const handlers = { chunk: null, done: null };
  return {
    handlers,
    bridge: {
      getStatus: jest.fn().mockResolvedValue(initialStatus),
      startChat: jest.fn().mockResolvedValue({ streamId: 'stream-1' }),
      cancelChat: jest.fn().mockResolvedValue({ cancelled: true }),
      onChatChunk: jest.fn((cb) => {
        handlers.chunk = cb;
        return jest.fn();
      }),
      onChatDone: jest.fn((cb) => {
        handlers.done = cb;
        return jest.fn();
      }),
    },
  };
}

const loadChatUi = async ({
  initialStatus,
  agent: agentOverride,
} = {}) => {
  jest.resetModules();

  const messagesEl = createElement('div');
  const composerEl = createElement('form');
  const inputEl = createElement('textarea');
  const sendBtn = createElement('button');
  const stopBtn = createElement('button');
  const modelSelect = createElement('select');
  const clearBtn = createElement('button');
  const statusBadge = createElement('span');

  const document = createDocument({
    elementsById: {
      'agent-messages': messagesEl,
      'agent-composer': composerEl,
      'agent-input': inputEl,
      'agent-send-btn': sendBtn,
      'agent-stop-btn': stopBtn,
      'agent-model-select': modelSelect,
      'agent-clear-btn': clearBtn,
      'agent-status-badge': statusBadge,
    },
  });

  const { handlers, bridge } =
    agentOverride || createAgentBridge(initialStatus);

  global.window = { agent: bridge };
  global.document = document;
  global.marked = { setOptions: jest.fn(), parse: jest.fn((t) => `<p>${t}</p>`) };
  global.DOMPurify = { sanitize: jest.fn((html) => html) };

  jest.doMock('../debug.js', () => ({ pushDebug: jest.fn() }));

  const mod = await import('./chat-ui.js');
  mod.initChatUi();
  await flushMicrotasks();

  return {
    mod,
    handlers,
    bridge,
    document,
    messagesEl,
    composerEl,
    inputEl,
    sendBtn,
    stopBtn,
    modelSelect,
    clearBtn,
    statusBadge,
  };
};

describe('chat-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.marked = originalMarked;
    global.DOMPurify = originalDOMPurify;
    jest.restoreAllMocks();
  });

  test('shows daemon version when running', async () => {
    const { statusBadge } = await loadChatUi({
      initialStatus: { running: true, version: '0.23.2', models: [] },
    });
    expect(statusBadge.textContent).toBe('v0.23.2');
    expect(statusBadge.classList.contains('running')).toBe(true);
  });

  test('shows offline state when daemon is unreachable', async () => {
    const { statusBadge } = await loadChatUi({
      initialStatus: { running: false, error: 'ECONNREFUSED', models: [] },
    });
    expect(statusBadge.textContent).toBe('offline');
    expect(statusBadge.classList.contains('error')).toBe(true);
  });

  test('populates model select with installed models, prefers default fallback', async () => {
    const { modelSelect } = await loadChatUi({
      initialStatus: {
        running: true,
        version: '0.23.2',
        models: [{ name: 'qwen3:0.6b' }, { name: 'gemma3:4b' }],
      },
    });
    const optValues = modelSelect.children.map((c) => c.value);
    expect(optValues).toEqual(['qwen3:0.6b', 'gemma3:4b']);
    expect(modelSelect.value).toBe('gemma3:4b');
  });

  test('falls back to default model name when no models installed', async () => {
    const { modelSelect } = await loadChatUi({
      initialStatus: { running: true, version: '0.23.2', models: [] },
    });
    expect(modelSelect.children.map((c) => c.value)).toEqual(['gemma3:4b']);
    expect(modelSelect.value).toBe('gemma3:4b');
  });

  test('submit pushes user message + assistant placeholder and starts a stream', async () => {
    const { mod, bridge, inputEl, composerEl } = await loadChatUi();
    inputEl.value = 'hello';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    expect(bridge.startChat).toHaveBeenCalledWith('gemma3:4b', [{ role: 'user', content: 'hello' }]);
    expect(mod._internals.state.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
    ]);
    expect(mod._internals.state.activeStreamId).toBe('stream-1');
  });

  test('chunks accumulate into the assistant message and re-render via marked', async () => {
    const { mod, handlers, inputEl, composerEl } = await loadChatUi();
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    handlers.chunk({ streamId: 'stream-1', content: 'Hel' });
    handlers.chunk({ streamId: 'stream-1', content: 'lo!' });

    const assistant = mod._internals.state.messages[1];
    expect(assistant.content).toBe('Hello!');
    expect(global.marked.parse).toHaveBeenCalledWith('Hello!');
  });

  test('ignores chunks for stale streamIds', async () => {
    const { mod, handlers, inputEl, composerEl } = await loadChatUi();
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    handlers.chunk({ streamId: 'stream-OTHER', content: 'X' });
    expect(mod._internals.state.messages[1].content).toBe('');
  });

  test('done event finalises the assistant message and re-enables composer', async () => {
    const { mod, handlers, inputEl, sendBtn, stopBtn, composerEl } = await loadChatUi();
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();
    expect(stopBtn.classList.contains('hidden')).toBe(false);

    handlers.done({
      streamId: 'stream-1',
      fullContent: 'Hello!',
      stats: { usage: { totalTokens: 5 } },
    });

    expect(mod._internals.state.activeStreamId).toBeNull();
    expect(stopBtn.classList.contains('hidden')).toBe(true);
    expect(sendBtn.classList.contains('hidden')).toBe(false);
    expect(inputEl.disabled).toBe(false);
  });

  test('error in startChat result finalises the message with the error', async () => {
    const { handlers: _handlers, bridge: _bridge } = createAgentBridge();
    _bridge.startChat = jest.fn().mockResolvedValue({ error: 'no model' });
    const { mod, inputEl, composerEl, messagesEl } = await loadChatUi({
      agent: { handlers: _handlers, bridge: _bridge },
    });
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    expect(mod._internals.state.activeStreamId).toBeNull();
    const assistantEl = messagesEl.children[messagesEl.children.length - 1];
    expect(assistantEl.classList.contains('error')).toBe(true);
  });

  test('stop button calls cancelChat with active streamId', async () => {
    const { bridge, inputEl, composerEl, stopBtn } = await loadChatUi();
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    stopBtn.dispatch('click');
    await flushMicrotasks();
    expect(bridge.cancelChat).toHaveBeenCalledWith('stream-1');
  });

  test('clear button resets messages list when no active stream', async () => {
    const { mod, handlers, inputEl, composerEl, clearBtn } = await loadChatUi();
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();
    handlers.done({ streamId: 'stream-1', fullContent: 'Hi back' });

    clearBtn.dispatch('click');
    expect(mod._internals.state.messages).toEqual([]);
  });

  test('refreshes status when its own ai-sidebar opens', async () => {
    const { bridge, document } = await loadChatUi();
    bridge.getStatus.mockClear();
    document.handlers['sidebar-opened']({ detail: { id: 'ai-sidebar' } });
    await flushMicrotasks();
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);
  });

  test('does not refresh status when another sidebar opens', async () => {
    const { bridge, document } = await loadChatUi();
    bridge.getStatus.mockClear();
    document.handlers['sidebar-opened']({ detail: { id: 'sidebar' } });
    await flushMicrotasks();
    expect(bridge.getStatus).not.toHaveBeenCalled();
  });
});
