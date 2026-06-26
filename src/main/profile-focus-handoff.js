const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FOCUS_REQUEST_FILE = 'profile-focus-request.json';
const FOCUS_ACK_FILE = 'profile-focus-ack.json';
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 1800;
const DEFAULT_MAX_REQUEST_AGE_MS = 10000;

function getProfileFocusPaths(profile) {
  if (!profile?.userDataDir) {
    throw new Error('Profile userDataDir is required for focus handoff');
  }

  return {
    requestPath: path.join(profile.userDataDir, FOCUS_REQUEST_FILE),
    ackPath: path.join(profile.userDataDir, FOCUS_ACK_FILE),
  };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function makeNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function requestProfileFocusSync(profile, options = {}) {
  const paths = getProfileFocusPaths(profile);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const nonce = options.nonce || makeNonce();
  const request = {
    type: 'focus-window',
    nonce,
    profileId: profile.id || null,
    requestedAtMs: Date.now(),
    pid: process.pid,
  };

  try {
    writeJsonAtomic(paths.requestPath, request);
  } catch (error) {
    return {
      ok: false,
      error: error.message || 'Focus request could not be written',
      nonce,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const ack = readJsonFile(paths.ackPath);
    if (ack?.nonce === nonce) {
      return {
        ok: ack.ok === true,
        error: ack.error || null,
        nonce,
      };
    }
    sleepSync(pollIntervalMs);
  }

  return {
    ok: false,
    error: 'The running profile did not respond',
    nonce,
  };
}

// Fire-and-forget variant of requestProfileFocusSync: writes the focus-request
// file and returns immediately without polling for an ack. Used by a running
// process to focus ANOTHER already-running profile's window without spawning a
// throwaway process (and without blocking the main thread on the ack).
function requestProfileFocusAsync(profile, options = {}) {
  const paths = getProfileFocusPaths(profile);
  const nonce = options.nonce || makeNonce();
  const request = {
    type: 'focus-window',
    nonce,
    profileId: profile.id || null,
    requestedAtMs: Date.now(),
    pid: process.pid,
  };

  try {
    writeJsonAtomic(paths.requestPath, request);
    return { ok: true, nonce };
  } catch (error) {
    return { ok: false, error: error.message || 'Focus request could not be written', nonce };
  }
}

function isFreshRequest(request, maxAgeMs) {
  if (!request || request.type !== 'focus-window' || typeof request.nonce !== 'string') {
    return false;
  }

  const requestedAtMs = Number(request.requestedAtMs);
  if (!Number.isFinite(requestedAtMs)) {
    return false;
  }

  return Date.now() - requestedAtMs <= maxAgeMs;
}

function startProfileFocusRequestWatcher(profile, onFocusWindow, options = {}) {
  const paths = getProfileFocusPaths(profile);
  const logger = options.logger || console;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxRequestAgeMs = options.maxRequestAgeMs ?? DEFAULT_MAX_REQUEST_AGE_MS;

  let stopped = false;
  let handling = false;
  let lastNonce = null;

  const writeAck = (request, result) => {
    try {
      writeJsonAtomic(paths.ackPath, {
        nonce: request.nonce,
        ok: result.ok === true,
        error: result.error || null,
        handledAtMs: Date.now(),
        pid: process.pid,
      });
    } catch (error) {
      logger.warn?.('[profile-focus] Failed to write focus acknowledgement:', error.message);
    }
  };

  const checkRequest = async () => {
    if (stopped || handling) return;

    const request = readJsonFile(paths.requestPath);
    if (!isFreshRequest(request, maxRequestAgeMs) || request.nonce === lastNonce) {
      return;
    }

    handling = true;
    lastNonce = request.nonce;
    try {
      await onFocusWindow(request);
      writeAck(request, { ok: true });
    } catch (error) {
      logger.warn?.('[profile-focus] Failed to focus existing profile window:', error);
      writeAck(request, {
        ok: false,
        error: error.message || 'Focus request failed',
      });
    } finally {
      handling = false;
    }
  };

  const timer = setInterval(() => {
    void checkRequest();
  }, pollIntervalMs);
  timer.unref?.();
  void checkRequest();

  return {
    requestPath: paths.requestPath,
    ackPath: paths.ackPath,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = {
  DEFAULT_MAX_REQUEST_AGE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FOCUS_ACK_FILE,
  FOCUS_REQUEST_FILE,
  getProfileFocusPaths,
  requestProfileFocusAsync,
  requestProfileFocusSync,
  startProfileFocusRequestWatcher,
};
