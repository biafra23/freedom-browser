const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function resolveDir(envName, fallbackName) {
  const override = process.env[envName];
  if (override) {
    return ensureDir(override);
  }
  return ensureDir(path.join(app.getPath('userData'), fallbackName));
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
  return resolveDir('FREEDOM_RADICLE_DATA', 'radicle-data');
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
