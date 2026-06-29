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
  // Intent flag only — the cold-started process maps it to the internal
  // settings deep-link, so no URL travels on the command line.
  const extraArgs = options.openSettings ? ['--open-settings'] : [];

  if (activeProfile?.isDev) {
    const repoRoot = activeProfile.repoRoot || path.join(__dirname, '..', '..');
    return {
      command: execPath,
      args: [repoRoot, profileArg, ...extraArgs],
      cwd: repoRoot,
    };
  }

  if (platform === 'darwin') {
    const appBundlePath = options.appBundlePath || getMacAppBundlePath(execPath);
    if (appBundlePath) {
      return {
        command: 'open',
        args: ['-n', appBundlePath, '--args', profileArg, ...extraArgs],
        cwd: undefined,
      };
    }
  }

  return {
    command: execPath,
    args: [profileArg, ...extraArgs],
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

// Open a profile, shared by the renderer IPC path and the native menu so both
// behave identically. If the target profile is already running, focus its
// window (fast — no new process); otherwise cold-start it. Deps are injectable
// for testing.
//
// Returns one of:
//   { focused: true }              — a running profile acknowledged the focus
//   { focused: false, launch }     — cold-started a new process
//   { focused: false, error }      — the profile is running but did not respond
//                                    to the focus request (we don't cold-start a
//                                    duplicate against its live lock)
//
// The ack round-trip is what lets callers report a *confirmed* focus instead of
// merely "the request was written" — see requestProfileFocusAsyncAwait.
async function openOrFocusProfile(activeProfile, profileId, options = {}) {
  // Lazy-required so this module stays loadable in isolation (and to avoid any
  // load-order coupling with profile-resolver).
  const resolveFocusTarget =
    options.getFocusTarget ||
    require('./profile-resolver').getProfileFocusTargetForActiveApp;
  const requestFocus =
    options.requestFocus || require('./profile-focus-handoff').requestProfileFocusAsyncAwait;

  const target = resolveFocusTarget(profileId);
  if (target?.isLocked) {
    const focus = await requestFocus(target, { openSettings: options.openSettings === true });
    if (focus?.ok) {
      return { focused: true };
    }
    // The request was written but the running profile never acknowledged it.
    // It holds a live lock, so cold-starting would just spawn a process that
    // bounces off ELOCKED — surface the failure instead.
    if (focus?.timedOut) {
      return { focused: false, error: focus.error || 'The running profile did not respond' };
    }
    // Otherwise the request couldn't even be written (e.g. the profile's data
    // dir is gone): fall through and cold-start.
  }

  const launch = launchProfile(activeProfile, profileId, options);
  return { focused: false, launch };
}

module.exports = {
  buildProfileLaunchCommand,
  getMacAppBundlePath,
  launchProfile,
  openOrFocusProfile,
};
