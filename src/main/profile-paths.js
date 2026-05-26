const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RADICLE_SOCKET_PATH_LIMIT = 100;
const RADICLE_SHORT_HOME_DIR = '.fr';
const RADICLE_SHORT_HOME_HASH_LENGTH = 8;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function hasEntries(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function resolveDir(envName, fallbackName) {
  const override = process.env[envName];
  if (override) {
    return ensureDir(override);
  }
  return ensureDir(path.join(app.getPath('userData'), fallbackName));
}

function getShortRadicleDataDir(profileRadicleDir) {
  const key = crypto
    .createHash('sha256')
    .update(path.resolve(profileRadicleDir))
    .digest('hex')
    .slice(0, RADICLE_SHORT_HOME_HASH_LENGTH);
  return path.join(os.homedir(), RADICLE_SHORT_HOME_DIR, key);
}

function copyLegacyRadicleDataIfNeeded(profileRadicleDir, shortRadicleDir) {
  if (!hasEntries(profileRadicleDir) || hasEntries(shortRadicleDir)) {
    return;
  }

  fs.mkdirSync(path.dirname(shortRadicleDir), { recursive: true });
  fs.cpSync(profileRadicleDir, shortRadicleDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

function getProfileUserDataDir() {
  return app.getPath('userData');
}

function getIdentityDataDir() {
  return resolveDir('FREEDOM_IDENTITY_DATA', 'identity');
}

function getBeeDataDir() {
  return resolveDir('FREEDOM_BEE_DATA', 'bee-data');
}

function getIpfsDataDir() {
  return resolveDir('FREEDOM_IPFS_DATA', 'ipfs-data');
}

function getRadicleDataDir() {
  const override = process.env.FREEDOM_RADICLE_DATA;
  if (override) {
    return ensureDir(override);
  }

  const profileRadicleDir = path.join(app.getPath('userData'), 'radicle-data');
  const socketPath = path.join(profileRadicleDir, 'node', 'control.sock');

  if (process.platform === 'win32' || socketPath.length < RADICLE_SOCKET_PATH_LIMIT) {
    return ensureDir(profileRadicleDir);
  }

  const shortRadicleDir = getShortRadicleDataDir(profileRadicleDir);
  copyLegacyRadicleDataIfNeeded(profileRadicleDir, shortRadicleDir);
  return ensureDir(shortRadicleDir);
}

function getQuickUnlockCredentialPath() {
  return path.join(getIdentityDataDir(), 'quick-unlock.dat');
}

function getProfileCrashDir() {
  return ensureDir(path.join(app.getPath('userData'), 'crash-reports'));
}

function getProfileTempDir() {
  return ensureDir(path.join(app.getPath('userData'), 'tmp'));
}

function createProfileTempDir(prefix) {
  const safePrefix = String(prefix || 'tmp')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'tmp';
  return fs.mkdtempSync(path.join(getProfileTempDir(), `${safePrefix}-`));
}

module.exports = {
  createProfileTempDir,
  getBeeDataDir,
  getIdentityDataDir,
  getIpfsDataDir,
  getProfileCrashDir,
  getProfileTempDir,
  getProfileUserDataDir,
  getQuickUnlockCredentialPath,
  getRadicleDataDir,
};
