const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getProfileFocusPaths,
  requestProfileFocusSync,
  startProfileFocusRequestWatcher,
} = require('./profile-focus-handoff');

function makeTempProfile(id = 'default') {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-focus-'));
  return {
    id,
    displayName: id === 'default' ? 'Default' : id,
    userDataDir,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

describe('profile focus handoff', () => {
  let tempDirs = [];
  let watchers = [];

  afterEach(() => {
    watchers.forEach((watcher) => watcher.stop());
    watchers = [];
    tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    tempDirs = [];
  });

  function trackProfile(profile) {
    tempDirs.push(profile.userDataDir);
    return profile;
  }

  function trackWatcher(watcher) {
    watchers.push(watcher);
    return watcher;
  }

  test('writes a focus request and reports no acknowledgement when no process responds', () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);

    const result = requestProfileFocusSync(profile, {
      nonce: 'focus-1',
      timeoutMs: 20,
      pollIntervalMs: 5,
    });

    expect(result).toEqual({
      ok: false,
      error: 'The running profile did not respond',
      nonce: 'focus-1',
    });
    expect(readJson(paths.requestPath)).toMatchObject({
      type: 'focus-window',
      nonce: 'focus-1',
      profileId: 'work',
    });
  });

  test('focus watcher handles a fresh request and writes an acknowledgement', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);
    trackWatcher(startProfileFocusRequestWatcher(profile, onFocusWindow, {
      pollIntervalMs: 10,
    }));

    fs.writeFileSync(
      paths.requestPath,
      JSON.stringify({
        type: 'focus-window',
        nonce: 'focus-2',
        profileId: 'work',
        requestedAtMs: Date.now(),
      }),
      'utf-8'
    );

    await waitFor(() => fs.existsSync(paths.ackPath));

    expect(onFocusWindow).toHaveBeenCalledTimes(1);
    expect(readJson(paths.ackPath)).toMatchObject({
      nonce: 'focus-2',
      ok: true,
      error: null,
    });
  });

  test('focus watcher ignores stale requests', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);

    fs.writeFileSync(
      paths.requestPath,
      JSON.stringify({
        type: 'focus-window',
        nonce: 'old-focus',
        profileId: 'work',
        requestedAtMs: Date.now() - 2000,
      }),
      'utf-8'
    );

    trackWatcher(startProfileFocusRequestWatcher(profile, onFocusWindow, {
      pollIntervalMs: 10,
      maxRequestAgeMs: 100,
    }));

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(onFocusWindow).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.ackPath)).toBe(false);
  });
});
