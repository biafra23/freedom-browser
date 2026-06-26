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
        getInstallRelaunchMode: () => ({ menuLabel: 'Install Update and Restart...' }),
        isUpdateReady: () => false,
        installUpdate: jest.fn(),
      }),
      [require.resolve('./profile-resolver')]: () => ({
        getActiveProfile: () => ({ id: 'alpha', source: 'catalog', isActive: true }),
        listProfilesForActiveApp: () => [
          { id: 'alpha', displayName: 'Alpha', isActive: true },
          { id: 'beta', displayName: 'Beta' },
        ],
      }),
      [require.resolve('./profile-launcher')]: () => ({
        openOrFocusProfile: jest.fn(),
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

  test('Profiles menu lists profiles plus create/manage actions', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const profiles = findTopLabel(capturedTemplate, 'Profiles');

      expect(profiles).toBeTruthy();
      const labels = profiles.submenu.map((item) => item.label ?? item.type);
      expect(labels).toEqual(
        expect.arrayContaining(['Alpha', 'Beta', 'Create Profile...', 'Manage Profiles...'])
      );

      // Current profile is a checked + disabled checkbox; the other is a plain
      // selectable item (NOT a checkbox — macOS auto-checks checkbox items on
      // click, which would leave a phantom checkmark after switching).
      const alpha = profiles.submenu.find((item) => item.label === 'Alpha');
      const beta = profiles.submenu.find((item) => item.label === 'Beta');
      expect(alpha.type).toBe('checkbox');
      expect(alpha.checked).toBe(true);
      expect(alpha.enabled).toBe(false);
      expect(beta.type).not.toBe('checkbox');
      expect(beta.checked).toBeFalsy();
      expect(beta.enabled).not.toBe(false);
      expect(typeof beta.click).toBe('function');
    }
  });

  test('File menu no longer includes the profile management entry', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const file = findTopLabel(capturedTemplate, 'File');

      expect(file?.submenu?.map((item) => item.label)).not.toContain('Manage Profiles...');
    }
  });

  test('Profiles menu sits between History and the Window menu on macOS', () => {
    const { capturedTemplate } = loadMenuModule('darwin');
    const labels = capturedTemplate.map((item) => item.label ?? item.role);
    const historyIndex = labels.indexOf('History');
    const profilesIndex = labels.indexOf('Profiles');
    const windowIndex = labels.indexOf('windowMenu');

    expect(profilesIndex).toBe(historyIndex + 1);
    expect(windowIndex).toBeGreaterThan(profilesIndex);
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
