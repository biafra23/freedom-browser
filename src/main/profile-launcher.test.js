const path = require('path');
const {
  buildProfileLaunchCommand,
  getMacAppBundlePath,
  launchProfile,
  openOrFocusProfile,
} = require('./profile-launcher');

describe('profile launcher', () => {
  test('derives the macOS app bundle path from the executable path', () => {
    expect(
      getMacAppBundlePath('/Applications/Freedom.app/Contents/MacOS/Freedom')
    ).toBe('/Applications/Freedom.app');
    expect(getMacAppBundlePath('/usr/bin/freedom')).toBeNull();
  });

  test('builds a dev launch command using the checkout root', () => {
    const command = buildProfileLaunchCommand(
      {
        isDev: true,
        repoRoot: '/repo/freedom-browser',
      },
      'work',
      {
        execPath: '/repo/freedom-browser/node_modules/.bin/electron',
        platform: 'darwin',
      }
    );

    expect(command).toEqual({
      command: '/repo/freedom-browser/node_modules/.bin/electron',
      args: ['/repo/freedom-browser', '--profile=work'],
      cwd: '/repo/freedom-browser',
    });
  });

  test('builds a packaged macOS launch command with open -n', () => {
    const command = buildProfileLaunchCommand(
      { isDev: false },
      'work',
      {
        execPath: '/Applications/Freedom.app/Contents/MacOS/Freedom',
        platform: 'darwin',
      }
    );

    expect(command).toEqual({
      command: 'open',
      args: ['-n', '/Applications/Freedom.app', '--args', '--profile=work'],
      cwd: undefined,
    });
  });

  test('builds a packaged non-mac launch command from the executable', () => {
    const command = buildProfileLaunchCommand(
      { isDev: false },
      'work',
      {
        execPath: path.join('C:', 'Program Files', 'Freedom', 'Freedom.exe'),
        platform: 'win32',
      }
    );

    expect(command).toEqual({
      command: path.join('C:', 'Program Files', 'Freedom', 'Freedom.exe'),
      args: ['--profile=work'],
      cwd: undefined,
    });
  });

  test('appends --open-settings after the profile arg when requested', () => {
    expect(
      buildProfileLaunchCommand(
        { isDev: true, repoRoot: '/repo/freedom-browser' },
        'work',
        { execPath: '/electron', platform: 'linux', openSettings: true }
      ).args
    ).toEqual(['/repo/freedom-browser', '--profile=work', '--open-settings']);

    expect(
      buildProfileLaunchCommand(
        { isDev: false },
        'work',
        { execPath: '/Applications/Freedom.app/Contents/MacOS/Freedom', platform: 'darwin', openSettings: true }
      ).args
    ).toEqual(['-n', '/Applications/Freedom.app', '--args', '--profile=work', '--open-settings']);
  });

  test('spawns detached and unrefs the launched process', () => {
    const child = { unref: jest.fn() };
    const spawn = jest.fn(() => child);
    const command = launchProfile(
      {
        isDev: true,
        repoRoot: '/repo/freedom-browser',
      },
      'work',
      {
        env: { FREEDOM_DEV_HOME: '/tmp/freedom-dev' },
        execPath: '/electron',
        platform: 'linux',
        spawn,
      }
    );

    expect(command).toEqual({
      command: '/electron',
      args: ['/repo/freedom-browser', '--profile=work'],
      cwd: '/repo/freedom-browser',
    });
    expect(spawn).toHaveBeenCalledWith('/electron', ['/repo/freedom-browser', '--profile=work'], {
      cwd: '/repo/freedom-browser',
      detached: true,
      env: { FREEDOM_DEV_HOME: '/tmp/freedom-dev' },
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalled();
  });

  describe('openOrFocusProfile', () => {
    const activeProfile = { isDev: true, repoRoot: '/repo/freedom-browser', source: 'catalog' };

    test('focuses an already-running profile without spawning', () => {
      const spawn = jest.fn();
      const requestFocus = jest.fn(() => ({ ok: true, nonce: 'n' }));
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: true }));

      const result = openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn,
      });

      expect(result).toEqual({ focused: true });
      expect(requestFocus).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'work', isLocked: true }),
        { openSettings: false }
      );
      expect(spawn).not.toHaveBeenCalled();
    });

    test('forwards openSettings to the focus request', () => {
      const requestFocus = jest.fn(() => ({ ok: true, nonce: 'n' }));
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: true }));

      openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn: jest.fn(),
        openSettings: true,
      });

      expect(requestFocus).toHaveBeenCalledWith(expect.any(Object), { openSettings: true });
    });

    test('launches when the profile is not running', () => {
      const child = { unref: jest.fn() };
      const spawn = jest.fn(() => child);
      const requestFocus = jest.fn();
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: false }));

      const result = openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn,
        execPath: '/electron',
        platform: 'linux',
      });

      expect(result.focused).toBe(false);
      expect(result.launch).toEqual({
        command: '/electron',
        args: ['/repo/freedom-browser', '--profile=work'],
        cwd: '/repo/freedom-browser',
      });
      expect(requestFocus).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
    });

    test('falls back to launching when the focus request cannot be written', () => {
      const child = { unref: jest.fn() };
      const spawn = jest.fn(() => child);
      const requestFocus = jest.fn(() => ({ ok: false, error: 'nope' }));
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: true }));

      const result = openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn,
        execPath: '/electron',
        platform: 'linux',
      });

      expect(result.focused).toBe(false);
      expect(spawn).toHaveBeenCalled();
    });
  });
});
