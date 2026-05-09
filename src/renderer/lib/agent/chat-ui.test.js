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
  const handlers = {
    chunk: null,
    thinking: null,
    done: null,
    toolCall: null,
    toolResult: null,
    consentRequest: null,
    notice: null,
  };
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
      onThinkingChunk: jest.fn((cb) => {
        handlers.thinking = cb;
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
      onChatNotice: jest.fn((cb) => {
        handlers.notice = cb;
        return jest.fn();
      }),
      listSkills: jest.fn().mockResolvedValue([]),
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
      thinkingLevel: 'medium',
      activeWebContentsId: 99,
    });
    // Assistant message is created lazily on the first chunk / tool /
    // thinking event — no chunks have arrived yet, so only the user
    // message is in state.messages.
    expect(mod._internals.state.messages).toEqual([
      { role: 'user', content: 'hello' },
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

  test('ignores chunks for stale streamIds (no assistant bubble created)', async () => {
    const { mod, handlers, inputEl, composerEl } = await loadChatUi();
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();
    handlers.chunk({ streamId: 'stream-OTHER', content: 'X' });
    // Stale chunk → ensureActiveAssistant is gated behind the active
    // streamId check, so no assistant message is created.
    expect(mod._internals.state.messages).toHaveLength(1);
  });

  test('thinking chunks accumulate on the active assistant + render a disclosure', async () => {
    const { mod, handlers, inputEl, composerEl, messagesEl } = await loadChatUi();
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    handlers.thinking({ streamId: 'stream-1', content: 'reasoning ' });
    handlers.thinking({ streamId: 'stream-1', content: 'about it...' });

    const last = mod._internals.state.messages[1];
    expect(last.thinking).toBe('reasoning about it...');
    const disclosure = messagesEl.querySelector('.agent-message-thinking');
    expect(disclosure).toBeTruthy();
    const body = disclosure.querySelector('.agent-message-thinking-body');
    expect(body.textContent).toBe('reasoning about it...');
  });

  test('thinking chunks for stale streamIds are ignored', async () => {
    const { mod, handlers, inputEl, composerEl, messagesEl } = await loadChatUi();
    inputEl.value = 'hi';
    composerEl.dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();
    handlers.thinking({ streamId: 'stream-OTHER', content: 'leak' });
    expect(mod._internals.state.messages).toHaveLength(1);
    expect(messagesEl.querySelector('.agent-message-thinking')).toBeFalsy();
  });

  test('restored session with persisted thinking renders the disclosure', async () => {
    const { handlers: _handlers, bridge: _bridge } = createAgentBridge();
    _bridge.getSession = jest.fn().mockResolvedValue({
      id: '/tmp/sessions/prev.jsonl',
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'recalled reasoning' },
            { type: 'text', text: 'recalled answer' },
          ],
        },
      ],
    });
    const { mod, messagesEl } = await loadChatUi({
      agent: { handlers: _handlers, bridge: _bridge },
    });
    await mod.loadSessionById('/tmp/sessions/prev.jsonl');

    const disclosure = messagesEl.querySelector('.agent-message-thinking');
    expect(disclosure).toBeTruthy();
    expect(disclosure.querySelector('.agent-message-thinking-body').textContent).toBe(
      'recalled reasoning'
    );
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

  test('does NOT auto-resume the most recent session on init — fresh start instead', async () => {
    const { handlers: _handlers, bridge: _bridge } = createAgentBridge();
    // Even if a recent session exists on disk, init shouldn't fetch it.
    _bridge.getSession = jest.fn();
    const { mod } = await loadChatUi({ agent: { handlers: _handlers, bridge: _bridge } });
    expect(_bridge.getSession).not.toHaveBeenCalled();
    expect(mod._internals.state.currentSessionId).toBeNull();
    expect(mod._internals.state.messages).toEqual([]);
  });

  test('loadSessionById hydrates from a saved session and surfaces its messages', async () => {
    const { handlers: _handlers, bridge: _bridge } = createAgentBridge();
    _bridge.getSession = jest.fn().mockResolvedValue({
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
    await mod.loadSessionById('/tmp/sessions/prev.jsonl');

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

    test('consent-request with signDetails:typed-data renders the decoded EIP-712 panel', async () => {
      const { handlers, messagesEl } = await startChatAndCapture();
      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'c2',
        name: 'wallet_sign_typed_data',
        tier: 'identity_or_signing',
        args: {},
      });
      handlers.consentRequest({
        streamId: 'stream-1',
        callId: 'c2',
        name: 'wallet_sign_typed_data',
        tier: 'identity_or_signing',
        args: {},
        description: 'sign Permit for USD Coin with the active wallet. Reason: r.',
        signDetails: {
          kind: 'typed-data',
          reason: 'permit Uniswap',
          domain: {
            name: 'USD Coin',
            chainId: 1,
            verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            verifyingContractUrl:
              'https://etherscan.io/address/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          },
          primaryType: 'Permit',
          message: {
            owner: '0xMAIN',
            spender: '0xUNI',
            value: '1000000',
          },
          types: { Permit: [{ name: 'value', type: 'uint256' }] },
        },
      });

      const card = messagesEl.querySelector('.agent-tool-card');
      const panel = card.querySelector('.agent-tool-card-typed-data');
      expect(panel).toBeTruthy();
      // Domain pills, primary type label, message rows, schema disclosure all present.
      const headings = card.querySelectorAll('.agent-tool-card-typed-heading');
      expect(headings.length).toBe(2);
      expect(headings[0].textContent).toBe('Domain');
      expect(headings[1].textContent).toBe('Message');
      expect(card.querySelector('.agent-tool-card-typed-primary').textContent).toBe(
        'Type: Permit'
      );
      const link = card.querySelector('.agent-tool-card-typed-link');
      expect(link).toBeTruthy();
      expect(link.href).toContain('etherscan.io');
      // fake-dom's textContent is a flat property, not recursive — gather
      // text from every descendant manually to assert the message rows
      // landed in the panel.
      const collect = (el) => {
        let s = el.textContent || '';
        for (const c of el.children || []) s += ' ' + collect(c);
        return s;
      };
      const panelText = collect(card.querySelector('.agent-tool-card-typed-data'));
      expect(panelText).toContain('owner');
      expect(panelText).toContain('0xMAIN');
      expect(panelText).toContain('value');
      const schema = card.querySelector('.agent-tool-card-typed-schema');
      expect(schema).toBeTruthy();
    });

    test('typed-data consent omits rows with null/undefined/empty values', async () => {
      const { handlers, messagesEl } = await startChatAndCapture();
      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'c3',
        name: 'wallet_sign_typed_data',
        tier: 'identity_or_signing',
        args: {},
      });
      handlers.consentRequest({
        streamId: 'stream-1',
        callId: 'c3',
        name: 'wallet_sign_typed_data',
        tier: 'identity_or_signing',
        args: {},
        description: 'sign Foo with the active wallet',
        signDetails: {
          kind: 'typed-data',
          domain: { name: 'Test', version: null, chainId: 1, verifyingContract: '' },
          primaryType: 'Foo',
          message: { keep: 'value', drop: undefined, also_drop: null, blank: '' },
          types: {},
        },
      });
      const card = messagesEl.querySelector('.agent-tool-card');
      const collect = (el) => {
        let s = el.textContent || '';
        for (const c of el.children || []) s += ' ' + collect(c);
        return s;
      };
      const panelText = collect(card.querySelector('.agent-tool-card-typed-data'));
      expect(panelText).toContain('keep');
      expect(panelText).toContain('value');
      expect(panelText).not.toContain('drop');
      expect(panelText).not.toContain('also_drop');
      expect(panelText).not.toContain('blank');
      // Empty types object → no schema disclosure rendered
      expect(card.querySelector('.agent-tool-card-typed-schema')).toBeFalsy();
    });

    test('typed-data consent shows "(empty)" placeholder when message is empty', async () => {
      const { handlers, messagesEl } = await startChatAndCapture();
      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'c4',
        name: 'wallet_sign_typed_data',
        tier: 'identity_or_signing',
        args: {},
      });
      handlers.consentRequest({
        streamId: 'stream-1',
        callId: 'c4',
        name: 'wallet_sign_typed_data',
        tier: 'identity_or_signing',
        args: {},
        description: 'sign Foo with the active wallet',
        signDetails: {
          kind: 'typed-data',
          domain: { name: 'Test', chainId: 1 },
          primaryType: 'Foo',
          message: {},
          types: {},
        },
      });
      const card = messagesEl.querySelector('.agent-tool-card');
      const empty = card.querySelector('.agent-tool-card-typed-empty');
      expect(empty).toBeTruthy();
      expect(empty.textContent).toBe('(empty)');
    });

    test('typed-data consent renders nested message values as a JSON sub-disclosure', async () => {
      const { handlers, messagesEl } = await startChatAndCapture();
      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'c5',
        name: 'wallet_sign_typed_data',
        tier: 'identity_or_signing',
        args: {},
      });
      handlers.consentRequest({
        streamId: 'stream-1',
        callId: 'c5',
        name: 'wallet_sign_typed_data',
        tier: 'identity_or_signing',
        args: {},
        description: 'sign Order with the active wallet',
        signDetails: {
          kind: 'typed-data',
          domain: { name: 'Test', chainId: 1 },
          primaryType: 'Order',
          message: {
            maker: '0xMAKER',
            items: [
              { token: '0xaaaa', amount: '100' },
              { token: '0xbbbb', amount: '200' },
            ],
          },
          types: {},
        },
      });
      const card = messagesEl.querySelector('.agent-tool-card');
      const collect = (el) => {
        let s = el.textContent || '';
        for (const c of el.children || []) s += ' ' + collect(c);
        return s;
      };
      const panelText = collect(card.querySelector('.agent-tool-card-typed-data'));
      // The "[2 items]" summary is the sub-disclosure label for the array.
      expect(panelText).toContain('[2 items]');
      // Pretty JSON of the nested value lives inside the disclosure body.
      expect(panelText).toContain('0xaaaa');
      expect(panelText).toContain('0xbbbb');
    });
  });

  describe('composer behaviour', () => {
    test('send button starts disabled and toggles with input value', async () => {
      const { inputEl, sendBtn } = await loadChatUi();

      expect(sendBtn.disabled).toBe(true);

      inputEl.value = 'hello';
      inputEl.dispatch('input');
      expect(sendBtn.disabled).toBe(false);

      inputEl.value = '   ';
      inputEl.dispatch('input');
      expect(sendBtn.disabled).toBe(true);
    });

    test('send button re-disables after submit clears the input', async () => {
      const { inputEl, sendBtn, composerEl, handlers } = await loadChatUi();
      inputEl.value = 'hi';
      inputEl.dispatch('input');
      expect(sendBtn.disabled).toBe(false);

      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();

      handlers.done({
        streamId: 'stream-1',
        fullContent: 'hi',
        stats: { usage: { totalTokens: 1, outputTokens: 1 } },
      });

      expect(inputEl.value).toBe('');
      expect(sendBtn.disabled).toBe(true);
    });

    test('input event auto-grows textarea height to its scrollHeight, clamped at 200px', async () => {
      const { inputEl } = await loadChatUi();

      inputEl.scrollHeight = 80;
      inputEl.dispatch('input');
      expect(inputEl.style.height).toBe('80px');

      inputEl.scrollHeight = 500;
      inputEl.dispatch('input');
      expect(inputEl.style.height).toBe('200px');
    });

    test('notice handler renders an info bubble into the message stream', async () => {
      const { handlers, messagesEl } = await loadChatUi();
      handlers.notice({ kind: 'info', text: 'Compaction started.' });
      const notice = messagesEl.querySelector('.agent-notice.agent-notice-info');
      expect(notice).toBeTruthy();
      expect(notice.textContent).toBe('Compaction started.');
    });

    test('notice handler renders an error bubble with the error variant class', async () => {
      const { handlers, messagesEl } = await loadChatUi();
      handlers.notice({ kind: 'error', text: 'Boom.' });
      const notice = messagesEl.querySelector('.agent-notice.agent-notice-error');
      expect(notice).toBeTruthy();
      expect(notice.textContent).toBe('Boom.');
    });

    test('notice with no text is silently ignored', async () => {
      const { handlers, messagesEl } = await loadChatUi();
      handlers.notice({ kind: 'info' });
      expect(messagesEl.querySelector('.agent-notice')).toBeNull();
    });

    test('compaction-start renders a sticky pulsing indicator and end mutates it in place', async () => {
      const { handlers, messagesEl } = await loadChatUi();

      handlers.notice({ kind: 'compaction-start', text: 'Compacting context…' });
      const start = messagesEl.querySelector('.agent-notice-compaction');
      expect(start).toBeTruthy();
      expect(start.classList.contains('compacting')).toBe(true);
      expect(start.textContent).toBe('Compacting context…');

      handlers.notice({
        kind: 'compaction-end',
        text: 'Context compacted (12.3k tokens summarised)',
      });
      const allCompactions = messagesEl.querySelectorAll('.agent-notice-compaction');
      // Same element — the end mutates the start, doesn't append a new one.
      expect(allCompactions).toHaveLength(1);
      expect(allCompactions[0].classList.contains('compacting')).toBe(false);
      expect(allCompactions[0].textContent).toBe(
        'Context compacted (12.3k tokens summarised)'
      );
    });

    test('compaction-end without a prior start renders a standalone marker', async () => {
      const { handlers, messagesEl } = await loadChatUi();
      handlers.notice({ kind: 'compaction-end', text: 'Context compacted' });
      const el = messagesEl.querySelector('.agent-notice-compaction');
      expect(el).toBeTruthy();
      expect(el.classList.contains('compacting')).toBe(false);
      expect(el.textContent).toBe('Context compacted');
    });

    test('two back-to-back compaction cycles each get their own marker', async () => {
      const { handlers, messagesEl } = await loadChatUi();
      handlers.notice({ kind: 'compaction-start', text: 'Compacting…' });
      handlers.notice({ kind: 'compaction-end', text: 'Context compacted (3k tokens)' });
      handlers.notice({ kind: 'compaction-start', text: 'Compacting…' });
      handlers.notice({ kind: 'compaction-end', text: 'Context compacted (5k tokens)' });

      const markers = messagesEl.querySelectorAll('.agent-notice-compaction');
      expect(markers).toHaveLength(2);
      expect(markers[0].textContent).toBe('Context compacted (3k tokens)');
      expect(markers[1].textContent).toBe('Context compacted (5k tokens)');
    });

    test('slash-pick handler inserts /cmd with trailing space for arg-taking commands and does NOT submit', async () => {
      const { mod, inputEl, composerEl } = await loadChatUi();
      const submitHandler = jest.fn();
      composerEl.addEventListener('submit', submitHandler);

      mod._internals.handleSlashCommandPick({ name: 'export', argsHint: '[path]' });

      expect(inputEl.value).toBe('/export ');
      expect(submitHandler).not.toHaveBeenCalled();
    });

    test('slash-pick handler auto-submits no-arg commands without the trailing space', async () => {
      const { mod, inputEl, composerEl } = await loadChatUi();
      const submitHandler = jest.fn();
      composerEl.addEventListener('submit', submitHandler);

      mod._internals.handleSlashCommandPick({ name: 'compact', argsHint: null });

      expect(inputEl.value).toBe('/compact');
      expect(submitHandler).toHaveBeenCalledTimes(1);
    });

    test('slash-pick uses cmd.insertName + appends "Apply now." imperative for no-arg skills', async () => {
      const { mod, inputEl, composerEl } = await loadChatUi();
      const submitHandler = jest.fn();
      composerEl.addEventListener('submit', submitHandler);

      mod._internals.handleSlashCommandPick({
        name: 'tldr',
        insertName: 'skill:tldr',
        argsHint: null,
      });

      // Pi's `_expandSkillCommand` only injects the imperative when args
      // follow the `/skill:foo` token — without them the model treats the
      // expanded skill body as a definition and just acknowledges.
      expect(inputEl.value).toBe('/skill:tldr Apply now.');
      expect(submitHandler).toHaveBeenCalledTimes(1);
    });

    test('slash-pick on a skill that takes args inserts /skill:<name> with trailing space (no imperative)', async () => {
      const { mod, inputEl, composerEl } = await loadChatUi();
      const submitHandler = jest.fn();
      composerEl.addEventListener('submit', submitHandler);

      mod._internals.handleSlashCommandPick({
        name: 'research',
        insertName: 'skill:research',
        argsHint: '<topic>',
      });

      expect(inputEl.value).toBe('/skill:research ');
      expect(submitHandler).not.toHaveBeenCalled();
    });

    test('user bubble for a /skill:foo Apply now. submission renders as /foo (imperative stripped)', async () => {
      const { handlers, inputEl, composerEl, messagesEl } = await loadChatUi();
      // Simulate the auto-submit path: handleSlashCommandPick sets the value
      // to "/skill:tldr Apply now." then dispatches submit.
      inputEl.value = '/skill:tldr Apply now.';
      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();
      handlers.done({ streamId: 'stream-1', fullContent: 'short answer.', stats: {} });

      const userBubble = messagesEl
        .querySelector('.agent-message.user')
        .querySelector('.agent-message-content');
      expect(userBubble.textContent).toBe('/tldr');
    });

    test('user bubble for /skill:research <topic> renders as /research <topic>', async () => {
      const { handlers, inputEl, composerEl, messagesEl } = await loadChatUi();
      inputEl.value = '/skill:research seahorses';
      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();
      handlers.done({ streamId: 'stream-1', fullContent: '...', stats: {} });

      const userBubble = messagesEl
        .querySelector('.agent-message.user')
        .querySelector('.agent-message-content');
      expect(userBubble.textContent).toBe('/research seahorses');
    });

    test('regular user messages render unchanged (no skill prefix to strip)', async () => {
      const { handlers, inputEl, composerEl, messagesEl } = await loadChatUi();
      inputEl.value = 'who are ninja turtles';
      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();
      handlers.done({ streamId: 'stream-1', fullContent: '...', stats: {} });

      const userBubble = messagesEl
        .querySelector('.agent-message.user')
        .querySelector('.agent-message-content');
      expect(userBubble.textContent).toBe('who are ninja turtles');
    });

    test('slash-pick does NOT dispatch an input event (would re-open the palette)', async () => {
      const { mod, inputEl, composerEl } = await loadChatUi();
      composerEl.addEventListener('submit', jest.fn()); // swallow the auto-submit
      const inputHandler = jest.fn();
      inputEl.addEventListener('input', inputHandler);

      mod._internals.handleSlashCommandPick({ name: 'compact', argsHint: null });

      // Must not synthesize an input event — the palette listens for one
      // and would re-show itself against the freshly-set `/compact`.
      expect(inputHandler).not.toHaveBeenCalled();
    });
  });

  describe('lazy assistant bubble', () => {
    test('no assistant bubble appears until the first chunk / tool / thinking event', async () => {
      const { inputEl, composerEl, messagesEl } = await loadChatUi();
      inputEl.value = 'hello';
      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();

      const assistantBubbles = messagesEl.querySelectorAll('.agent-message.assistant');
      expect(assistantBubbles).toHaveLength(0);
    });

    test('first chunk lazily creates the assistant bubble', async () => {
      const { handlers, inputEl, composerEl, messagesEl } = await loadChatUi();
      inputEl.value = 'hello';
      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();

      handlers.chunk({ streamId: 'stream-1', content: 'Hi!' });

      const assistantBubbles = messagesEl.querySelectorAll('.agent-message.assistant');
      expect(assistantBubbles).toHaveLength(1);
    });

    test('done with no chunks (slash command) leaves no assistant bubble in the message list', async () => {
      const { mod, handlers, inputEl, composerEl, messagesEl } = await loadChatUi();
      inputEl.value = '/compact';
      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();

      handlers.done({ streamId: 'stream-1', fullContent: '', stats: {} });

      // User message stayed; no empty assistant bubble was created.
      expect(messagesEl.querySelectorAll('.agent-message.assistant')).toHaveLength(0);
      expect(mod._internals.state.messages).toEqual([{ role: 'user', content: '/compact' }]);
    });

    test('subagent inner tool calls nest inside the spawn_subagent card (Phase 6.7)', async () => {
      const { handlers, inputEl, composerEl, messagesEl } = await loadChatUi();
      inputEl.value = 'kick off';
      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();

      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'parent-1',
        name: 'spawn_subagent',
        tier: 'local_safe',
        args: { subagent_id: 'research_topic', prompt: 'investigate X' },
      });
      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'inner-1',
        name: 'navigate',
        tier: 'browser_mutation',
        args: { url: 'https://example.com' },
        subagentCallId: 'parent-1',
      });

      const parentCard = messagesEl.querySelector('[data-call-id="parent-1"]');
      const nestedSlot = parentCard.querySelector('.agent-tool-subagent-children');
      const innerCard = nestedSlot.querySelector('[data-call-id="inner-1"]');
      expect(innerCard).toBeTruthy();
      // Inner card lives under the spawn_subagent card, not as a sibling.
      const siblings = messagesEl.querySelectorAll('[data-call-id="inner-1"]');
      expect(siblings).toHaveLength(1);
    });

    test('a tool call without subagentCallId attaches to the assistant bubble as a top-level sibling', async () => {
      const { handlers, inputEl, composerEl, messagesEl } = await loadChatUi();
      inputEl.value = 'go';
      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();

      handlers.toolCall({
        streamId: 'stream-1',
        callId: 'top-1',
        name: 'navigate',
        tier: 'browser_mutation',
        args: { url: 'https://example.com' },
      });

      const card = messagesEl.querySelector('[data-call-id="top-1"]');
      // Parent should be the assistant bubble (.agent-message.assistant), not nested.
      let p = card.parentNode;
      while (p && !p.classList?.contains('agent-message')) p = p.parentNode;
      expect(p?.classList?.contains('assistant')).toBe(true);
    });

    test('error result still creates a bubble so the user sees the failure', async () => {
      const { handlers: _handlers, bridge: _bridge } = createAgentBridge();
      _bridge.startChat = jest.fn().mockResolvedValue({ error: 'Ollama not running' });
      const { inputEl, composerEl, messagesEl } = await loadChatUi({
        agent: { handlers: _handlers, bridge: _bridge },
      });
      inputEl.value = 'hi';
      composerEl.dispatch('submit', { preventDefault: jest.fn() });
      await flushMicrotasks();

      const assistantBubbles = messagesEl.querySelectorAll('.agent-message.assistant.error');
      expect(assistantBubbles).toHaveLength(1);
      const contentEl = assistantBubbles[0].querySelector('.agent-message-content');
      expect(contentEl.textContent).toContain('Ollama not running');
    });
  });

  describe('skills wiring', () => {
    test('init fetches skills via window.agent.listSkills', async () => {
      const { bridge } = await loadChatUi();
      expect(bridge.listSkills).toHaveBeenCalledTimes(1);
    });

    test('listSkills failure does not throw out of init', async () => {
      const { handlers: _handlers, bridge: _bridge } = createAgentBridge();
      _bridge.listSkills = jest.fn().mockRejectedValue(new Error('boom'));
      await expect(
        loadChatUi({ agent: { handlers: _handlers, bridge: _bridge } })
      ).resolves.toBeDefined();
    });
  });
});
