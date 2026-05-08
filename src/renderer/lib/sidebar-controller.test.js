const { createElement, createDocument } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadController = async ({
  initialSettings = { enableLocalAI: true },
  config = {
    id: 'ai-sidebar',
    toggleBtnId: 'ai-toggle-btn',
    closeBtnId: 'ai-sidebar-close',
    featureFlagKey: 'enableLocalAI',
    keybindingKey: 'A',
    name: 'ai',
  },
  settingsRejects = false,
} = {}) => {
  jest.resetModules();

  const sidebar = createElement('aside', { classes: ['sidebar', 'collapsed'] });
  const toggleBtn = createElement('button');
  const closeBtn = createElement('button');

  const document = createDocument({
    elementsById: {
      [config.id]: sidebar,
      [config.toggleBtnId]: toggleBtn,
      [config.closeBtnId]: closeBtn,
    },
  });
  document.dispatchEvent = jest.fn();

  const windowHandlers = {};
  const electronAPI = {
    getSettings: jest.fn(() =>
      settingsRejects ? Promise.reject(new Error('boom')) : Promise.resolve(initialSettings)
    ),
  };

  global.window = {
    electronAPI,
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
    dispatchEvent: jest.fn(),
  };
  global.document = document;

  const { createSidebarController } = await import('./sidebar-controller.js');
  const controller = createSidebarController(config);
  controller.init();
  await flushMicrotasks();

  return {
    controller,
    sidebar,
    toggleBtn,
    closeBtn,
    document,
    electronAPI,
    windowHandlers,
    config,
  };
};

describe('sidebar-controller', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('hides toggle button when feature flag is off', async () => {
    const { toggleBtn, controller } = await loadController({
      initialSettings: { enableLocalAI: false },
    });

    expect(toggleBtn.classList.contains('hidden')).toBe(true);
    expect(controller.isFeatureEnabled()).toBe(false);
  });

  test('shows toggle button when feature flag is on', async () => {
    const { toggleBtn, controller } = await loadController();

    expect(toggleBtn.classList.contains('hidden')).toBe(false);
    expect(controller.isFeatureEnabled()).toBe(true);
  });

  test('hides toggle button when settings load fails', async () => {
    const { toggleBtn, controller } = await loadController({ settingsRejects: true });

    expect(toggleBtn.classList.contains('hidden')).toBe(true);
    expect(controller.isFeatureEnabled()).toBe(false);
  });

  test('toggle opens and closes the sidebar; click on button toggles', async () => {
    const { toggleBtn, sidebar, controller } = await loadController();

    expect(controller.isVisible()).toBe(false);
    expect(sidebar.classList.contains('collapsed')).toBe(true);

    toggleBtn.dispatch('click');
    expect(controller.isVisible()).toBe(true);
    expect(sidebar.classList.contains('collapsed')).toBe(false);
    expect(toggleBtn.classList.contains('active')).toBe(true);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');

    toggleBtn.dispatch('click');
    expect(controller.isVisible()).toBe(false);
    expect(sidebar.classList.contains('collapsed')).toBe(true);
    expect(toggleBtn.classList.contains('active')).toBe(false);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
  });

  test('does nothing when feature is disabled', async () => {
    const { toggleBtn, controller, sidebar } = await loadController({
      initialSettings: { enableLocalAI: false },
    });

    toggleBtn.dispatch('click');
    expect(controller.isVisible()).toBe(false);
    expect(sidebar.classList.contains('collapsed')).toBe(true);

    controller.open();
    expect(controller.isVisible()).toBe(false);
  });

  test('close button closes the sidebar', async () => {
    const { closeBtn, controller } = await loadController();

    controller.open();
    expect(controller.isVisible()).toBe(true);

    closeBtn.dispatch('click');
    expect(controller.isVisible()).toBe(false);
  });

  test('dispatches sidebar-opened / sidebar-closed events with detail.id', async () => {
    const { controller, config } = await loadController();
    const events = [];
    global.document.dispatchEvent = jest.fn((event) => {
      events.push({ type: event.type, detail: event.detail });
    });

    controller.open();
    controller.close();

    expect(events).toEqual([
      { type: 'sidebar-opened', detail: { id: config.id } },
      { type: 'sidebar-closed', detail: { id: config.id } },
    ]);
  });

  test('closes when a sibling sidebar opens', async () => {
    const { controller, document } = await loadController();

    controller.open();
    expect(controller.isVisible()).toBe(true);

    document.handlers['sidebar-opened']({ detail: { id: 'other-sidebar' } });
    expect(controller.isVisible()).toBe(false);
  });

  test('ignores its own sidebar-opened broadcast', async () => {
    const { controller, document, config } = await loadController();

    controller.open();
    expect(controller.isVisible()).toBe(true);

    document.handlers['sidebar-opened']({ detail: { id: config.id } });
    expect(controller.isVisible()).toBe(true);
  });

  test('cmd/ctrl+shift+<key> toggles when feature is enabled', async () => {
    const { controller, document } = await loadController();

    document.handlers['keydown']({
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      key: 'A',
      preventDefault: jest.fn(),
    });
    expect(controller.isVisible()).toBe(true);

    document.handlers['keydown']({
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      key: 'A',
      preventDefault: jest.fn(),
    });
    expect(controller.isVisible()).toBe(false);
  });

  test('keybinding is no-op when feature is disabled', async () => {
    const { controller, document } = await loadController({
      initialSettings: { enableLocalAI: false },
    });

    const e = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      key: 'A',
      preventDefault: jest.fn(),
    };
    document.handlers['keydown'](e);
    expect(controller.isVisible()).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  test('settings:updated re-applies feature flag and auto-closes when disabled mid-session', async () => {
    const { controller, toggleBtn, windowHandlers, config } = await loadController();

    controller.open();
    expect(controller.isVisible()).toBe(true);

    windowHandlers['settings:updated']({ detail: { [config.featureFlagKey]: false } });
    expect(controller.isFeatureEnabled()).toBe(false);
    expect(toggleBtn.classList.contains('hidden')).toBe(true);
    expect(controller.isVisible()).toBe(false);
  });

  test('settings:updated re-enables a previously hidden toggle', async () => {
    const { controller, toggleBtn, windowHandlers, config } = await loadController({
      initialSettings: { enableLocalAI: false },
    });

    expect(toggleBtn.classList.contains('hidden')).toBe(true);

    windowHandlers['settings:updated']({ detail: { [config.featureFlagKey]: true } });
    expect(controller.isFeatureEnabled()).toBe(true);
    expect(toggleBtn.classList.contains('hidden')).toBe(false);
  });
});
