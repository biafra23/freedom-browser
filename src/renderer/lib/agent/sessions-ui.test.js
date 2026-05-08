const { createElement, createDocument } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function createBridge(options = {}) {
  return {
    listSessions: jest.fn().mockResolvedValue(options.sessions || []),
    getSession: jest
      .fn()
      .mockImplementation((id) => Promise.resolve({ id, messages: [] })),
    renameSession: jest.fn().mockResolvedValue({ ok: true }),
    deleteSession: jest.fn().mockResolvedValue({ ok: true }),
  };
}

const loadSessionsUi = async ({ sessions = [], currentSessionId = null } = {}) => {
  jest.resetModules();

  const toggleBtn = createElement('button');
  const chatView = createElement('div');
  const sessionsView = createElement('div', { classes: ['hidden'] });
  const listEl = createElement('ul');
  const emptyEl = createElement('div', { classes: ['hidden'] });

  const document = createDocument({
    elementsById: {
      'agent-sessions-toggle-btn': toggleBtn,
      'agent-chat-view': chatView,
      'agent-sessions-view': sessionsView,
      'agent-sessions-list': listEl,
      'agent-sessions-empty': emptyEl,
    },
  });

  const bridge = createBridge({ sessions });
  const loadSessionByIdMock = jest.fn().mockResolvedValue(true);
  const getCurrentSessionIdMock = jest.fn().mockReturnValue(currentSessionId);

  global.window = { agent: bridge };
  global.document = document;

  jest.doMock('../debug.js', () => ({ pushDebug: jest.fn() }));
  jest.doMock('./chat-ui.js', () => ({
    loadSessionById: loadSessionByIdMock,
    getCurrentSessionId: getCurrentSessionIdMock,
  }));

  const mod = await import('./sessions-ui.js');
  mod.initSessionsUi();
  await flushMicrotasks();

  return {
    mod,
    bridge,
    document,
    toggleBtn,
    chatView,
    sessionsView,
    listEl,
    emptyEl,
    loadSessionByIdMock,
  };
};

describe('sessions-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  describe('view swap', () => {
    test('toggle button hides chat and shows sessions on first click', async () => {
      const { toggleBtn, chatView, sessionsView } = await loadSessionsUi();

      toggleBtn.dispatch('click');
      await flushMicrotasks();

      expect(chatView.classList.contains('hidden')).toBe(true);
      expect(sessionsView.classList.contains('hidden')).toBe(false);
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
    });

    test('second click swaps back to chat view', async () => {
      const { toggleBtn, chatView, sessionsView } = await loadSessionsUi();

      toggleBtn.dispatch('click');
      await flushMicrotasks();
      toggleBtn.dispatch('click');
      await flushMicrotasks();

      expect(chatView.classList.contains('hidden')).toBe(false);
      expect(sessionsView.classList.contains('hidden')).toBe(true);
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe('list rendering', () => {
    test('shows empty state when no sessions exist', async () => {
      const { toggleBtn, listEl, emptyEl } = await loadSessionsUi({ sessions: [] });
      toggleBtn.dispatch('click');
      await flushMicrotasks();
      expect(listEl.children).toHaveLength(0);
      expect(emptyEl.classList.contains('hidden')).toBe(false);
    });

    test('renders one row per session with title and meta', async () => {
      const now = Date.now();
      const { toggleBtn, listEl, emptyEl } = await loadSessionsUi({
        sessions: [
          { id: 's1', title: 'First chat', updated_at: now - 10 * 60 * 1000 },
          { id: 's2', title: null, updated_at: now - 60 * 60 * 1000 },
        ],
      });
      toggleBtn.dispatch('click');
      await flushMicrotasks();

      expect(emptyEl.classList.contains('hidden')).toBe(true);
      expect(listEl.children).toHaveLength(2);
      const [first, second] = listEl.children;
      expect(first.dataset.sessionId).toBe('s1');
      expect(second.dataset.sessionId).toBe('s2');
      // The untitled fallback gets the 'untitled' class on the title.
      const secondTitle = second.querySelector('.agent-session-row-title');
      expect(secondTitle.classList.contains('untitled')).toBe(true);
      expect(secondTitle.textContent).toBe('(Untitled)');
    });

    test('marks the current session row with .active', async () => {
      const { toggleBtn, listEl } = await loadSessionsUi({
        sessions: [{ id: 's1', title: 'a', updated_at: Date.now() }],
        currentSessionId: 's1',
      });
      toggleBtn.dispatch('click');
      await flushMicrotasks();
      expect(listEl.children[0].classList.contains('active')).toBe(true);
    });
  });

  describe('row click loads the session and swaps to chat', () => {
    test('clicks call loadSessionById then swap views', async () => {
      const {
        toggleBtn,
        listEl,
        chatView,
        sessionsView,
        loadSessionByIdMock,
      } = await loadSessionsUi({
        sessions: [{ id: 's1', title: 'a', updated_at: Date.now() }],
      });
      toggleBtn.dispatch('click');
      await flushMicrotasks();

      listEl.children[0].dispatch('click');
      await flushMicrotasks();

      expect(loadSessionByIdMock).toHaveBeenCalledWith('s1');
      expect(chatView.classList.contains('hidden')).toBe(false);
      expect(sessionsView.classList.contains('hidden')).toBe(true);
    });

    test('does not swap to chat view if loadSessionById refuses', async () => {
      const sessions = [{ id: 's1', title: 'a', updated_at: Date.now() }];
      const ctx = await loadSessionsUi({ sessions });
      ctx.loadSessionByIdMock.mockResolvedValueOnce(false);
      ctx.toggleBtn.dispatch('click');
      await flushMicrotasks();
      ctx.listEl.children[0].dispatch('click');
      await flushMicrotasks();
      expect(ctx.sessionsView.classList.contains('hidden')).toBe(false);
      expect(ctx.chatView.classList.contains('hidden')).toBe(true);
    });
  });

  describe('rename', () => {
    test('clicking rename button replaces title with input', async () => {
      const { toggleBtn, listEl } = await loadSessionsUi({
        sessions: [{ id: 's1', title: 'old', updated_at: Date.now() }],
      });
      toggleBtn.dispatch('click');
      await flushMicrotasks();

      const row = listEl.children[0];
      const renameBtn = row.querySelectorAll('.agent-session-action-btn')[0];
      renameBtn.dispatch('click', { stopPropagation: jest.fn() });
      await flushMicrotasks();

      const input = row.querySelector('.agent-session-rename-input');
      expect(input).toBeTruthy();
      expect(input.value).toBe('old');
    });

    test('Enter on the input commits via renameSession and refreshes', async () => {
      const sessions = [{ id: 's1', title: 'old', updated_at: Date.now() }];
      const { toggleBtn, listEl, bridge } = await loadSessionsUi({ sessions });
      toggleBtn.dispatch('click');
      await flushMicrotasks();

      const row = listEl.children[0];
      const renameBtn = row.querySelectorAll('.agent-session-action-btn')[0];
      renameBtn.dispatch('click', { stopPropagation: jest.fn() });
      await flushMicrotasks();

      const input = row.querySelector('.agent-session-rename-input');
      input.value = 'new title';
      input.dispatch('keydown', { key: 'Enter', preventDefault: jest.fn() });
      await flushMicrotasks();

      expect(bridge.renameSession).toHaveBeenCalledWith('s1', 'new title');
      expect(bridge.listSessions).toHaveBeenCalledTimes(2); // initial + post-rename
    });

    test('Escape on the input cancels without renameSession', async () => {
      const sessions = [{ id: 's1', title: 'old', updated_at: Date.now() }];
      const { toggleBtn, listEl, bridge } = await loadSessionsUi({ sessions });
      toggleBtn.dispatch('click');
      await flushMicrotasks();

      const row = listEl.children[0];
      const renameBtn = row.querySelectorAll('.agent-session-action-btn')[0];
      renameBtn.dispatch('click', { stopPropagation: jest.fn() });
      await flushMicrotasks();

      const input = row.querySelector('.agent-session-rename-input');
      input.value = 'discarded';
      input.dispatch('keydown', { key: 'Escape', preventDefault: jest.fn() });
      await flushMicrotasks();

      expect(bridge.renameSession).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    test('delete button shows inline confirm; cancel aborts', async () => {
      const sessions = [{ id: 's1', title: 'a', updated_at: Date.now() }];
      const { toggleBtn, listEl, bridge } = await loadSessionsUi({ sessions });
      toggleBtn.dispatch('click');
      await flushMicrotasks();

      const row = listEl.children[0];
      const deleteBtn = row.querySelectorAll('.agent-session-action-btn')[1];
      deleteBtn.dispatch('click', { stopPropagation: jest.fn() });
      await flushMicrotasks();

      const cancelBtn = row.querySelector('.agent-session-confirm-btn.cancel');
      expect(cancelBtn).toBeTruthy();
      cancelBtn.dispatch('click', { stopPropagation: jest.fn() });
      await flushMicrotasks();

      expect(bridge.deleteSession).not.toHaveBeenCalled();
    });

    test('delete confirm calls deleteSession and refreshes', async () => {
      const sessions = [{ id: 's1', title: 'a', updated_at: Date.now() }];
      const { toggleBtn, listEl, bridge } = await loadSessionsUi({ sessions });
      toggleBtn.dispatch('click');
      await flushMicrotasks();

      const row = listEl.children[0];
      const deleteBtn = row.querySelectorAll('.agent-session-action-btn')[1];
      deleteBtn.dispatch('click', { stopPropagation: jest.fn() });
      await flushMicrotasks();

      // First button is "Delete" (yes); second is "Cancel".
      const confirmBtn = row.querySelectorAll('.agent-session-confirm-btn')[0];
      confirmBtn.dispatch('click', { stopPropagation: jest.fn() });
      await flushMicrotasks();

      expect(bridge.deleteSession).toHaveBeenCalledWith('s1');
      expect(bridge.listSessions).toHaveBeenCalledTimes(2);
    });
  });

  describe('formatRelativeTime', () => {
    test('renders age strings', async () => {
      const { mod } = await loadSessionsUi();
      const { formatRelativeTime } = mod._internals;
      const now = Date.now();
      expect(formatRelativeTime(now - 30 * 1000)).toBe('just now');
      expect(formatRelativeTime(now - 5 * 60 * 1000)).toBe('5m ago');
      expect(formatRelativeTime(now - 3 * 3600 * 1000)).toBe('3h ago');
      expect(formatRelativeTime(now - 25 * 3600 * 1000)).toBe('yesterday');
      expect(formatRelativeTime(now - 4 * 86400 * 1000)).toBe('4d ago');
      expect(formatRelativeTime(0)).toBe('');
    });
  });
});
