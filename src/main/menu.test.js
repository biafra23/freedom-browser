const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

function loadMenuModule(platform) {
  let capturedTemplate = null;
  const menuInstance = {
    on: jest.fn(),
    getMenuItemById: jest.fn(),
  };

  const { mod } = loadMainModule(require.resolve('./menu'), {
    electronOverrides: {
      Menu: {
        buildFromTemplate: jest.fn((template) => {
          capturedTemplate = template;
          return menuInstance;
        }),
        setApplicationMenu: jest.fn(),
        getApplicationMenu: jest.fn(() => menuInstance),
      },
    },
    extraMocks: {
      [require.resolve('./windows/mainWindow')]: () => ({
        isMainBrowserWindow: () => true,
        getMainWindows: () => [],
        createMainWindow: jest.fn(),
      }),
      [require.resolve('./updater')]: () => ({
        checkForUpdates: jest.fn(),
        isUpdateReady: () => false,
        installUpdate: jest.fn(),
      }),
    },
  });

  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });

  try {
    mod.setupApplicationMenu();
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }

  return { capturedTemplate, mod };
}

function findTopLabel(template, label) {
  return template.find((item) => item.label === label);
}

describe('menu', () => {
  test('Windows template omits macOS-only appMenu and windowMenu', () => {
    const { capturedTemplate } = loadMenuModule('win32');

    expect(capturedTemplate.some((item) => item.role === 'appMenu')).toBe(false);
    expect(capturedTemplate.some((item) => item.role === 'windowMenu')).toBe(false);
    expect(findTopLabel(capturedTemplate, 'File')).toBeTruthy();
    expect(findTopLabel(capturedTemplate, 'Edit')).toBeTruthy();
  });

  test('Linux template uses explicit Edit roles for clipboard accelerators', () => {
    const { capturedTemplate } = loadMenuModule('linux');
    const edit = findTopLabel(capturedTemplate, 'Edit');

    expect(edit?.submenu?.map((item) => item.role)).toEqual(
      expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll'])
    );
    expect(capturedTemplate.some((item) => item.role === 'appMenu')).toBe(false);
    expect(capturedTemplate.some((item) => item.role === 'windowMenu')).toBe(false);
  });

  test('macOS template keeps appMenu and editMenu roles', () => {
    const { capturedTemplate } = loadMenuModule('darwin');

    expect(capturedTemplate.some((item) => item.role === 'appMenu')).toBe(true);
    expect(capturedTemplate.some((item) => item.role === 'editMenu')).toBe(true);
    expect(capturedTemplate.some((item) => item.role === 'windowMenu')).toBe(true);
    expect(findTopLabel(capturedTemplate, 'Edit')).toBeFalsy();
  });
});
