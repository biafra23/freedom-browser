const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

let initAgentSidebar;
let toggle;
let open;
let close;
let isVisible;

let sidebar;
let toggleBtn;
let closeBtn;
let docMock;

function setupDom(initialClasses = ['agent-sidebar', 'collapsed']) {
  sidebar = createElement('aside', { classes: initialClasses });
  toggleBtn = createElement('button', { classes: ['agent-toggle-btn'] });
  toggleBtn.setAttribute('aria-expanded', 'false');
  closeBtn = createElement('button', { classes: ['agent-sidebar-close'] });

  docMock = createDocument({
    elementsById: {
      'agent-sidebar': sidebar,
      'agent-toggle-btn': toggleBtn,
      'agent-sidebar-close': closeBtn,
    },
  });
  // The fake DOM helper doesn't model dispatchEvent — stub it for the
  // CustomEvent broadcasts (`agent-sidebar-opened`/`-closed`).
  docMock.dispatchEvent = jest.fn();

  global.document = docMock;
  global.window = { addEventListener: jest.fn() };
  global.CustomEvent = function CustomEvent(type, init = {}) {
    return { type, detail: init.detail };
  };
}

beforeEach(async () => {
  setupDom();
  jest.resetModules();
  ({ initAgentSidebar, toggle, open, close, isVisible } = await import('./agent-sidebar.js'));
  initAgentSidebar();
});

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
});

describe('agent-sidebar', () => {
  test('starts collapsed', () => {
    expect(sidebar.classList.contains('collapsed')).toBe(true);
    expect(isVisible()).toBe(false);
  });

  test('toggle() opens then closes and updates aria-expanded', () => {
    toggle();
    expect(isVisible()).toBe(true);
    expect(sidebar.classList.contains('collapsed')).toBe(false);
    expect(toggleBtn.classList.contains('active')).toBe(true);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');

    toggle();
    expect(isVisible()).toBe(false);
    expect(sidebar.classList.contains('collapsed')).toBe(true);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
  });

  test('open() and close() are idempotent', () => {
    open();
    open();
    expect(isVisible()).toBe(true);
    close();
    close();
    expect(isVisible()).toBe(false);
  });

  test('clicking the toggle button opens the sidebar', () => {
    toggleBtn.dispatch('click');
    expect(isVisible()).toBe(true);
  });

  test('clicking the close button closes the sidebar', () => {
    open();
    closeBtn.dispatch('click');
    expect(isVisible()).toBe(false);
  });

  test('Cmd+Shift+A keydown toggles the sidebar', () => {
    const keyHandler = docMock.handlers.keydown;
    expect(typeof keyHandler).toBe('function');

    keyHandler({ key: 'A', metaKey: true, shiftKey: true, preventDefault: jest.fn() });
    expect(isVisible()).toBe(true);

    keyHandler({ key: 'a', ctrlKey: true, shiftKey: true, preventDefault: jest.fn() });
    expect(isVisible()).toBe(false);
  });
});
