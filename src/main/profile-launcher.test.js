const path = require('path');
const {
  buildProfileLaunchCommand,
  getMacAppBundlePath,
  launchProfile,
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
});
