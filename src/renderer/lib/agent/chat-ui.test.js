const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

let initChatUi;
let refreshStatus;

let elements;
let docMock;
let bridge;
let chunkCallbacks;
let doneCallbacks;

function setupDom() {
  elements = {
    'agent-status-badge': createElement('span'),
    'agent-model-select': createElement('select'),
    'agent-clear-btn': createElement('button'),
    'agent-messages': createElement('div'),
    'agent-composer': createElement('form'),
    'agent-input': createElement('textarea'),
    'agent-stop-btn': createElement('button', { classes: ['agent-stop-btn', 'hidden'] }),
    'agent-send-btn': createElement('button', { classes: ['agent-send-btn'] }),
  };
  // Wire textarea/select default values.
  elements['agent-input'].value = '';
  elements['agent-model-select'].value = '';
  // Track removeChild semantics for select.options when innerHTML cleared.
  Object.defineProperty(elements['agent-model-select'], 'options', {
    get() {
      return this.children;
    },
  });

  docMock = createDocument({ elementsById: elements });
  // Patch document.createElement to return option elements with proper shape.
  docMock.createElement = jest.fn((tagName) => createElement(tagName));

  global.document = docMock;
}

function setupAgentBridge(overrides = {}) {
  chunkCallbacks = [];
  doneCallbacks = [];
  bridge = {
    getStatus: jest.fn().mockResolvedValue({
      running: true,
      version: '0.23.2',
      models: [{ name: 'gemma4:e2b' }],
    }),
    startChat: jest.fn().mockResolvedValue({ streamId: 'stream-1' }),
    cancelChat: jest.fn().mockResolvedValue({ cancelled: true }),
    onChatChunk: jest.fn((cb) => {
      chunkCallbacks.push(cb);
      return () => {};
    }),
    onChatDone: jest.fn((cb) => {
      doneCallbacks.push(cb);
      return () => {};
    }),
    ...overrides,
  };
  global.window = { agent: bridge };
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

async function loadAndInit() {
  jest.resetModules();
  ({ initChatUi, refreshStatus } = await import('./chat-ui.js'));
  initChatUi();
  await refreshStatus();
}

beforeEach(() => {
  setupDom();
  setupAgentBridge();
});

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
});

describe('chat-ui', () => {
  test('renders an empty state on init', async () => {
    await loadAndInit();
    const empty = elements['agent-messages'].querySelector('.agent-empty-state');
    expect(empty).not.toBeNull();
  });

  test('refreshStatus populates select with daemon-reported models and prefers gemma4:e2b', async () => {
    setupAgentBridge({
      getStatus: jest.fn().mockResolvedValue({
        running: true,
        version: '0.23.2',
        models: [{ name: 'qwen3:0.6b' }, { name: 'gemma4:e2b' }],
      }),
    });
    await loadAndInit();

    const select = elements['agent-model-select'];
    const optionValues = select.children.map((c) => c.value);
    expect(optionValues).toEqual(['qwen3:0.6b', 'gemma4:e2b']);
    expect(select.value).toBe('gemma4:e2b');
    expect(elements['agent-status-badge'].textContent).toBe('v0.23.2');
    expect(elements['agent-status-badge'].classList.contains('running')).toBe(true);
  });

  test('refreshStatus marks badge as offline when daemon unreachable', async () => {
    setupAgentBridge({
      getStatus: jest.fn().mockResolvedValue({ running: false, models: [] }),
    });
    await loadAndInit();
    expect(elements['agent-status-badge'].classList.contains('error')).toBe(true);
    expect(elements['agent-status-badge'].textContent).toBe('offline');
  });

  test('submitting a message calls startChat and renders user message', async () => {
    await loadAndInit();
    elements['agent-input'].value = 'hello world';
    elements['agent-composer'].dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    expect(bridge.startChat).toHaveBeenCalledWith('gemma4:e2b', [
      { role: 'user', content: 'hello world' },
    ]);
    const userMsg = elements['agent-messages'].querySelector('.agent-message-content');
    expect(userMsg).not.toBeNull();
    expect(userMsg.textContent).toBe('hello world');
    const assistant = elements['agent-messages'].children.find((c) =>
      c.classList.contains('assistant')
    );
    expect(assistant).toBeTruthy();
    expect(assistant.classList.contains('streaming')).toBe(true);
  });

  test('streaming chunks accumulate into the assistant message and finalize on done', async () => {
    await loadAndInit();
    elements['agent-input'].value = 'hi';
    elements['agent-composer'].dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    chunkCallbacks[0]({ streamId: 'stream-1', content: 'Hel' });
    chunkCallbacks[0]({ streamId: 'stream-1', content: 'lo' });
    const assistantContent = elements['agent-messages']
      .children.find((c) => c.classList.contains('assistant'))
      .querySelector('.agent-message-content');
    expect(assistantContent.textContent).toBe('Hello');

    doneCallbacks[0]({
      streamId: 'stream-1',
      fullContent: 'Hello!',
      stats: { eval_count: 2, total_duration: 1_000_000_000 },
    });
    expect(assistantContent.textContent).toBe('Hello!');
    const assistant = elements['agent-messages'].children.find((c) =>
      c.classList.contains('assistant')
    );
    expect(assistant.classList.contains('streaming')).toBe(false);
    expect(assistant.querySelector('.agent-message-meta').textContent).toMatch(/2 tok/);
  });

  test('chunks for an unrelated streamId are ignored', async () => {
    await loadAndInit();
    elements['agent-input'].value = 'hi';
    elements['agent-composer'].dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    chunkCallbacks[0]({ streamId: 'wrong-id', content: 'noise' });
    const assistantContent = elements['agent-messages']
      .children.find((c) => c.classList.contains('assistant'))
      .querySelector('.agent-message-content');
    expect(assistantContent.textContent).toBe('');
  });

  test('done with error sets error class and message', async () => {
    await loadAndInit();
    elements['agent-input'].value = 'hi';
    elements['agent-composer'].dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    doneCallbacks[0]({ streamId: 'stream-1', fullContent: '', error: 'no model' });
    const assistant = elements['agent-messages'].children.find((c) =>
      c.classList.contains('assistant')
    );
    expect(assistant.classList.contains('error')).toBe(true);
    expect(assistant.querySelector('.agent-message-content').textContent).toMatch(/no model/);
  });

  test('stop button cancels the active stream', async () => {
    await loadAndInit();
    elements['agent-input'].value = 'hi';
    elements['agent-composer'].dispatch('submit', { preventDefault: jest.fn() });
    await flushMicrotasks();

    elements['agent-stop-btn'].dispatch('click');
    await flushMicrotasks();
    expect(bridge.cancelChat).toHaveBeenCalledWith('stream-1');
  });
});
