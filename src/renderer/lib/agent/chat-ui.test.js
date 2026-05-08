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
  const handlers = { chunk: null, done: null, toolCall: null, toolResult: null, consentRequest: null };
  return {
    handlers,
    bridge: {
      getStatus: jest.fn().mockResolvedValue(initialStatus),
      startChat: jest.fn().mockResolvedValue({ streamId: 'stream-1' }),
      cancelChat: jest.fn().mockResolvedValue({ cancelled: true }),
      respondConsent: jest.fn().mockResolvedValue({ ok: true }),
      onChatChunk: jest.fn((cb) => {
        handlers.chunk = cb;
        return jest.fn();
      }),
      onChatDone: jest.fn((cb) => {
        handlers.done = cb;
        return jest.fn();
      }),
      onToolCall: jest.fn((cb) => {
        handlers.toolCall = cb;
        return jest.fn();
      }),
      onToolResult: jest.fn((cb) => {
        handlers.toolResult = cb;
        return jest.fn();
      }),
      onConsentRequest: jest.fn((cb) => {
        handlers.consentRequest = cb;
        return jest.fn();
      }),
      getRecentSession: jest.fn().mockResolvedValue(null),
      createSession: jest
        .fn()
        .mockResolvedValue({ id: '/tmp/sessions/abc.jsonl', title: null }),
      listSessions: jest.fn().mockResolvedValue([]),
      getSession: jest.fn().mockResolvedValue(null),
      renameSession: jest.fn().mockResolvedValue({ ok: true }),
      deleteSession: jest.fn().mockResolvedValue({ ok: true }),
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
  const modelSelector = createElement('div');
  const modelBtn = createElement('button');
  const modelBtnName = createElement('span');
  const modelDropdown = createElement('div', { classes: ['hidden'] });
  const modelList = createElement('ul');
  const clearBtn = createElement('button');
  const statusBadge = createElement('span');

  const document = createDocument({
    elementsById: {
      'agent-messages': messagesEl,
      'agent-composer': composerEl,
      'agent-input': inputEl,
      'agent-send-btn': sendBtn,
      'agent-stop-btn': stopBtn,
      'agent-model-selector': modelSelector,
      'agent-model-btn': modelBtn,
      'agent-model-btn-name': modelBtnName,
      'agent-model-dropdown': modelDropdown,
      'agent-model-list': modelList,
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
  jest.doMock('../tabs.js', () => ({
    getActiveWebview: jest.fn(() => ({ getWebContentsId: () => 99 })),
  }));

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
    modelSelector,
    modelBtn,
    modelBtnName,
    modelDropdown,
    modelList,
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

  test('populates model dropdown with installed models, prefers default fallback', async () => {
    const { modelList, modelBtnName } = await loadChatUi({
      initialStatus: {
        running: true,
        version: '0.23.2',
        models: [{ name: 'qwen3:0.6b' }, { name: 'gemma4:e2b' }],
      },
    });
    const itemValues = modelList.children.map((c) => c.dataset.model);
    expect(itemValues).toEqual(['qwen3:0.6b', 'gemma4:e2b']);
    expect(modelBtnName.textContent).toBe('gemma4:e2b');
    const active = modelList.children.find((c) => c.classList.contains('active'));
    expect(active.dataset.model).toBe('gemma4:e2b');
  });

  test('falls back to default model name when no models installed', async () => {
    const { modelList, modelBtnName } = await loadChatUi({
      initialStatus: { running: true, version: '0.23.2', models: [] },
    });
    expect(modelList.children.map((c) => c.dataset.model)).toEqual(['gemma4:e2b']);
    expect(modelBtnName.textContent).toBe('gemma4:e2b');
  });

  test('clicking the model button toggles the dropdown', async () => {
    const { modelBtn, modelDropdown, modelSelector } = await loadChatUi();
    expect(modelDropdown.classList.contains('hidden')).toBe(true);
    modelBtn.dispatch('click');
    expect(modelDropdown.classList.contains('hidden')).toBe(false);
    expect(modelSelector.classList.contains('open')).toBe(true);
    modelBtn.dispatch('click');
    expect(modelDropdown.classList.contains('hidden')).toBe(true);
  });

  test('clicking a dropdown item selects the model and closes the dropdown', async () => {
    const { modelBtn, modelList, modelBtnName, modelDropdown } = await loadChatUi({
      initialStatus: {
        running: true,
        version: '0.23.2',
        models: [{ name: 'qwen3:0.6b' }, { name: 'gemma4:e2b' }],
      },
    });
    modelBtn.dispatch('click');
    const otherItem = modelList.children.find((c) => c.dataset.model === 'qwen3:0.6b');
    otherItem.dispatch('click');
    expect(modelBtnName.textContent).toBe('qwen3:0.6b');
    expect(modelDropdown.classList.contains('hidden')).toBe(true);
  });

  test('first submit creates a session, then calls startChat with sessionPath + prompt', async () => {
    const { mod, bridge, inputEl, composerEl } = await loadChatUi();
    inputEl.value = 'hello';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    expect(bridge.createSession).toHaveBeenCalledWith({ title: 'hello' });
    expect(bridge.startChat).toHaveBeenCalledWith({
      sessionPath: '/tmp/sessions/abc.jsonl',
      model: 'gemma4:e2b',
      prompt: 'hello',
      activeWebContentsId: 99,
    });
    expect(mod._internals.state.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
    ]);
    expect(mod._internals.state.activeStreamId).toBe('stream-1');
    expect(mod._internals.state.currentSessionId).toBe('/tmp/sessions/abc.jsonl');
  });

  test('chunks accumulate into the assistant message', async () => {
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
      stats: { usage: { totalTokens: 5, outputTokens: 5 } },
    });

    expect(mod._internals.state.activeStreamId).toBeNull();
    expect(stopBtn.classList.contains('hidden')).toBe(true);
    expect(sendBtn.classList.contains('hidden')).toBe(false);
    expect(inputEl.disabled).toBe(false);
  });

  test('error in startChat result finalises with the error class', async () => {
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

  test('clear button resets messages list and currentSessionId when no active stream', async () => {
    const { mod, handlers, inputEl, composerEl, clearBtn } = await loadChatUi();
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();
    handlers.done({ streamId: 'stream-1', fullContent: 'Hi back' });

    clearBtn.dispatch('click');
    expect(mod._internals.state.messages).toEqual([]);
    expect(mod._internals.state.currentSessionId).toBeNull();
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

  test('resumes the most recent session on init using Pi message shape', async () => {
    const { handlers: _handlers, bridge: _bridge } = createAgentBridge();
    _bridge.getRecentSession = jest.fn().mockResolvedValue({
      id: '/tmp/sessions/prev.jsonl',
      messages: [
        { role: 'user', content: 'last time I asked' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'and I answered' }],
        },
      ],
    });
    const { mod } = await loadChatUi({ agent: { handlers: _handlers, bridge: _bridge } });

    expect(mod._internals.state.currentSessionId).toBe('/tmp/sessions/prev.jsonl');
    expect(mod._internals.state.messages).toEqual([
      { role: 'user', content: 'last time I asked' },
      { role: 'assistant', content: 'and I answered' },
    ]);
  });

  test('does not create a session per submit — reuses currentSessionId', async () => {
    const { bridge, handlers, inputEl, composerEl } = await loadChatUi();

    inputEl.value = 'one';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();
    handlers.done({ streamId: 'stream-1', fullContent: 'reply one' });
    await flushMicrotasks();

    inputEl.value = 'two';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    expect(bridge.createSession).toHaveBeenCalledTimes(1);
  });

  test('clear forgets currentSessionId so the next message starts a new session', async () => {
    const { mod, bridge, clearBtn, inputEl, composerEl, handlers } = await loadChatUi();

    inputEl.value = 'first chat';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();
    handlers.done({ streamId: 'stream-1', fullContent: 'reply' });
    await flushMicrotasks();
    expect(mod._internals.state.currentSessionId).toBe('/tmp/sessions/abc.jsonl');

    clearBtn.dispatch('click');
    await flushMicrotasks();
    expect(mod._internals.state.currentSessionId).toBeNull();

    bridge.createSession.mockResolvedValueOnce({
      id: '/tmp/sessions/second.jsonl',
      title: null,
    });
    inputEl.value = 'second chat';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(mod._internals.state.currentSessionId).toBe('/tmp/sessions/second.jsonl');
  });

  // Phase 2 doesn't emit tool events from main, but the renderer's handlers
  // are kept ready for Phase 3. Drive them with synthetic events to confirm
  // the rendering path is intact.
  describe('tool-event handlers (synthetic; Phase 3 drives these for real)', () => {
    async function startChatAndCapture() {
      const ctx = await loadChatUi();
      ctx.inputEl.value = 'do a thing';
      ctx.composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();
      return ctx;
    }

    test('tool-call event renders a card under the active assistant message', async () => {
      const { mod, handlers, messagesEl } = await startChatAndCapture();
      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'c1',
        name: 'navigate',
        tier: 'browser_mutation',
        args: { url: 'https://example.com' },
      });

      const last = mod._internals.state.messages[mod._internals.state.messages.length - 1];
      expect(last.toolCalls).toHaveLength(1);
      const card = messagesEl.querySelector('.agent-tool-card');
      expect(card).toBeTruthy();
      expect(card.dataset.callId).toBe('c1');
    });

    test('tool-result event flips the card status', async () => {
      const { mod, handlers, messagesEl } = await startChatAndCapture();
      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'c1',
        name: 'navigate',
        tier: 'browser_mutation',
        args: { url: 'https://x' },
      });
      handlers.toolResult({
        streamId: 'stream-1',
        callId: 'c1',
        status: 'allowed',
        result: { url: 'https://x/' },
      });

      const last = mod._internals.state.messages[mod._internals.state.messages.length - 1];
      expect(last.toolCalls[0].status).toBe('allowed');
      const card = messagesEl.querySelector('.agent-tool-card');
      expect(card.classList.contains('allowed')).toBe(true);
    });

    test('consent-request renders three buttons; allow click forwards to bridge', async () => {
      const { bridge, handlers, messagesEl } = await startChatAndCapture();
      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'c1',
        name: 'navigate',
        tier: 'browser_mutation',
        args: { url: 'https://x' },
      });
      handlers.consentRequest({
        streamId: 'stream-1',
        callId: 'c1',
        name: 'navigate',
        tier: 'browser_mutation',
        args: { url: 'https://x' },
        description: 'navigate to https://x',
      });

      const card = messagesEl.querySelector('.agent-tool-card');
      expect(card.classList.contains('consent')).toBe(true);
      const buttons = card.querySelectorAll('.agent-tool-card-consent-btn');
      expect(buttons).toHaveLength(3);
      const allowBtn = card.querySelector('[data-action="allow"]');
      allowBtn.dispatch('click');
      await flushMicrotasks();
      expect(bridge.respondConsent).toHaveBeenCalledWith('stream-1', 'c1', 'allow');
    });
  });
});
