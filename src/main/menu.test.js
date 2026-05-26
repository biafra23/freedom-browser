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

  test('Windows and Linux place Edit immediately after File', () => {
    for (const platform of ['win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const labels = capturedTemplate.map((item) => item.label ?? item.role);
      const fileIndex = labels.indexOf('File');
      const editIndex = labels.indexOf('Edit');
      const viewIndex = labels.indexOf('View');

      expect(fileIndex).toBeGreaterThanOrEqual(0);
      expect(editIndex).toBe(fileIndex + 1);
      expect(viewIndex).toBeGreaterThan(editIndex);
    }
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

  test('File menu includes profile management entry', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const file = findTopLabel(capturedTemplate, 'File');

      expect(file?.submenu?.map((item) => item.label)).toEqual(
        expect.arrayContaining(['New Profile Window...'])
      );
    }
  });

  test('macOS template keeps appMenu and editMenu roles', () => {
    const { capturedTemplate } = loadMenuModule('darwin');

    expect(capturedTemplate.some((item) => item.role === 'appMenu')).toBe(true);
    expect(capturedTemplate.some((item) => item.role === 'editMenu')).toBe(true);
    expect(capturedTemplate.some((item) => item.role === 'windowMenu')).toBe(true);
    expect(findTopLabel(capturedTemplate, 'Edit')).toBeFalsy();
  });

  test('macOS places editMenu immediately after File', () => {
    const { capturedTemplate } = loadMenuModule('darwin');
    const labels = capturedTemplate.map((item) => item.label ?? item.role);
    const fileIndex = labels.indexOf('File');
    const editIndex = labels.indexOf('editMenu');
    const viewIndex = labels.indexOf('View');

    expect(fileIndex).toBeGreaterThanOrEqual(0);
    expect(editIndex).toBe(fileIndex + 1);
    expect(viewIndex).toBeGreaterThan(editIndex);
  });
});
