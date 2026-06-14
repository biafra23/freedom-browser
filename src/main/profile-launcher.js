const path = require('path');
const { spawn } = require('child_process');

function getMacAppBundlePath(execPath = process.execPath) {
  const normalized = path.normalize(execPath);
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return null;
  return normalized.slice(0, markerIndex);
}

function buildProfileLaunchCommand(activeProfile, profileId, options = {}) {
  const platform = options.platform || process.platform;
  const execPath = options.execPath || process.execPath;
  const profileArg = `--profile=${profileId}`;

  if (activeProfile?.isDev) {
    const repoRoot = activeProfile.repoRoot || path.join(__dirname, '..', '..');
    return {
      command: execPath,
      args: [repoRoot, profileArg],
      cwd: repoRoot,
    };
  }

  if (platform === 'darwin') {
    const appBundlePath = options.appBundlePath || getMacAppBundlePath(execPath);
    if (appBundlePath) {
      return {
        command: 'open',
        args: ['-n', appBundlePath, '--args', profileArg],
        cwd: undefined,
      };
    }
  }

  return {
    command: execPath,
    args: [profileArg],
    cwd: undefined,
  };
}

function launchProfile(activeProfile, profileId, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const command = buildProfileLaunchCommand(activeProfile, profileId, options);
  const child = spawnImpl(command.command, command.args, {
    cwd: command.cwd,
    detached: true,
    env: options.env || process.env,
    stdio: 'ignore',
  });

  if (typeof child?.unref === 'function') {
    child.unref();
  }

  return command;
}

module.exports = {
  buildProfileLaunchCommand,
  getMacAppBundlePath,
  launchProfile,
};
