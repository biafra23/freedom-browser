const originalWindow = global.window;
const originalDocument = global.document;
const originalNavigator = global.navigator;

const createClassList = (initialClasses = []) => {
  const classes = new Set(initialClasses);
  return {
    add: jest.fn((className) => classes.add(className)),
    remove: jest.fn((className) => classes.delete(className)),
    contains: jest.fn((className) => classes.has(className)),
  };
};

const createMenuItem = (action) => ({
  dataset: { action },
  disabled: false,
  closest: jest.fn((selector) => (selector === '.context-menu-item' ? createMenuItem(action) : null)),
});

const createInput = (value = 'hello world') => {
  let selectionStart = 0;
  let selectionEnd = 5;
  const handlers = {};

  const input = {
    value,
    selectionStart,
    selectionEnd,
    focus: jest.fn(),
    select: jest.fn(function selectAll() {
      const end = this.value.length;
      this.setSelectionRange(0, end);
    }),
    setSelectionRange: jest.fn((start, end) => {
      selectionStart = start;
      selectionEnd = end;
      input.selectionStart = start;
      input.selectionEnd = end;
    }),
    dispatchEvent: jest.fn(),
    addEventListener: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    handlers,
  };

  Object.defineProperty(input, 'selectionStart', {
    get: () => selectionStart,
    set: (v) => {
      selectionStart = v;
    },
  });
  Object.defineProperty(input, 'selectionEnd', {
    get: () => selectionEnd,
    set: (v) => {
      selectionEnd = v;
    },
  });

  return input;
};

const createContextMenu = () => {
  const handlers = {};
  const items = {
    cut: createMenuItem('cut'),
    copy: createMenuItem('copy'),
    paste: createMenuItem('paste'),
    'select-all': createMenuItem('select-all'),
  };

  return {
    handlers,
    classList: createClassList(['hidden']),
    style: {},
    querySelector: jest.fn((selector) => items[selector.match(/data-action="([^"]+)"/)[1]]),
    addEventListener: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    getBoundingClientRect: jest.fn(() => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    })),
    items,
  };
};

const loadModule = async ({ input, contextMenu, electronAPI } = {}) => {
  jest.resetModules();

  const addressInput = input ?? createInput();
  const menu = contextMenu ?? createContextMenu();

  global.document = {
    getElementById: jest.fn((id) => {
      if (id === 'address-input') return addressInput;
      if (id === 'chrome-input-context-menu') return menu;
      return null;
    }),
  };

  global.window = {
    innerWidth: 800,
    innerHeight: 600,
    electronAPI:
      electronAPI === null
        ? undefined
        : (electronAPI ?? {
            copyText: jest.fn().mockResolvedValue({ success: true }),
            readClipboardText: jest.fn().mockResolvedValue({ success: true, text: 'pasted' }),
          }),
  };

  global.navigator = {
    clipboard: {
      writeText: jest.fn().mockResolvedValue(undefined),
      readText: jest.fn().mockResolvedValue('pasted'),
    },
  };

  jest.doMock('./menu-backdrop.js', () => ({
    showMenuBackdrop: jest.fn(),
    hideMenuBackdrop: jest.fn(),
  }));

  const mod = await import('./chrome-input-context-menu.js');
  mod.initChromeInputContextMenu();
  return { mod, input: addressInput, menu };
};

const openContextMenu = (input, { collapseSelectionOnOpen = false } = {}) => {
  input.handlers.mousedown?.({ button: 2 });
  if (collapseSelectionOnOpen) {
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
  }
  input.handlers.contextmenu({
    preventDefault: jest.fn(),
    clientX: 10,
    clientY: 10,
  });
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const clickMenu = async (menu, action) => {
  const item = menu.items[action];
  item.closest.mockReturnValue(item);
  menu.handlers.click({
    target: item,
  });
  await flushMicrotasks();
};

describe('chrome-input-context-menu', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.navigator = originalNavigator;
    jest.clearAllMocks();
  });

  test('copy writes saved selection via clipboard API', async () => {
    const { input, menu } = await loadModule();
    openContextMenu(input);
    await clickMenu(menu, 'copy');

    expect(window.electronAPI.copyText).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('hello world');
  });

  test('cut removes selected text and writes to clipboard', async () => {
    const { input, menu } = await loadModule();
    openContextMenu(input);
    await clickMenu(menu, 'cut');

    expect(window.electronAPI.copyText).toHaveBeenCalledWith('hello');
    expect(input.value).toBe(' world');
  });

  test('paste inserts clipboard text at saved caret position', async () => {
    const input = createInput('hello world');
    input.setSelectionRange(6, 6);
    const { menu } = await loadModule({ input });

    openContextMenu(input);
    await clickMenu(menu, 'paste');

    expect(window.electronAPI.readClipboardText).toHaveBeenCalled();
    expect(input.value).toBe('hello pastedworld');
  });

  test('falls back to navigator clipboard write when electron copy is unavailable', async () => {
    const { input, menu } = await loadModule({ electronAPI: null });
    openContextMenu(input);
    await clickMenu(menu, 'copy');

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
  });

  test('copy uses selection captured on right mousedown when contextmenu collapses it', async () => {
    const input = createInput('copy-via-menu-69');
    input.setSelectionRange(0, input.value.length);
    const { menu } = await loadModule({ input });

    openContextMenu(input, { collapseSelectionOnOpen: true });
    await clickMenu(menu, 'copy');

    expect(window.electronAPI.copyText).toHaveBeenCalledWith('copy-via-menu-69');
  });

  test('falls back to navigator clipboard read when electron read is unavailable', async () => {
    const input = createInput('hello world');
    input.setSelectionRange(6, 6);
    const { menu } = await loadModule({ input, electronAPI: null });

    openContextMenu(input);
    await clickMenu(menu, 'paste');

    expect(navigator.clipboard.readText).toHaveBeenCalled();
    expect(input.value).toBe('hello pastedworld');
  });
});
