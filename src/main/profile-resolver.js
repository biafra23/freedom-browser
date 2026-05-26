const fs = require('fs');
const path = require('path');
const {
  DEFAULT_PROFILE_ID,
  createProfile,
  deleteProfile,
  ensureProfile,
  getCheckoutId,
  hashPath,
  listProfileSummaries,
  renameProfile,
  sanitizeProfileId,
  updateProfileNodeConfig,
} = require('./profile-catalog');

const LEGACY_DEV_DATA_DIRS = ['identity-data', 'bee-data', 'ipfs-data', 'radicle-data'];
const LEGACY_DEV_DATA_WARNING_FILE = 'legacy-dev-data-warning.json';

let activeProfile = null;

function getArgValue(argv, name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
    if (arg === `--${name}` && index + 1 < argv.length) {
      return argv[index + 1];
    }
  }
  return null;
}

function findRepoRoot(startDir) {
  let current = fs.realpathSync(startDir);

  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to find repository root from ${startDir}`);
    }
    current = parent;
  }
}

function getDefaultRepoRoot() {
  return findRepoRoot(path.join(__dirname, '..', '..'));
}

function resolveDevAppRoot(app, env, repoRoot) {
  if (env.FREEDOM_DEV_HOME) {
    return path.resolve(env.FREEDOM_DEV_HOME);
  }

  return path.join(app.getPath('appData'), 'Freedom Dev', getCheckoutId(repoRoot));
}

function resolveProfile(app, options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;

  if (env.FREEDOM_TEST_USER_DATA) {
    const userDataDir = path.resolve(env.FREEDOM_TEST_USER_DATA);
    return {
      id: 'test',
      displayName: 'Test',
      source: 'test-user-data',
      appRoot: userDataDir,
      userDataDir,
      isDev: !app.isPackaged,
      catalogPath: null,
      metadata: null,
    };
  }

  const explicitProfileDir = getArgValue(argv, 'profile-dir');
  if (explicitProfileDir) {
    const userDataDir = path.resolve(explicitProfileDir);
    const id = sanitizeProfileId(path.basename(userDataDir) || DEFAULT_PROFILE_ID);
    return {
      id,
      displayName: id,
      source: 'profile-dir',
      appRoot: userDataDir,
      userDataDir,
      isDev: !app.isPackaged,
      catalogPath: null,
      metadata: null,
    };
  }

  const isDev = !app.isPackaged;
  const repoRoot = options.repoRoot
    ? fs.realpathSync(options.repoRoot)
    : isDev
      ? getDefaultRepoRoot()
      : null;
  const checkoutHash = repoRoot ? hashPath(repoRoot) : null;
  const appRoot = isDev
    ? resolveDevAppRoot(app, env, repoRoot)
    : app.getPath('userData');
  const profileInput = getArgValue(argv, 'profile') || env.FREEDOM_PROFILE || DEFAULT_PROFILE_ID;
  const profileId = sanitizeProfileId(profileInput);
  const defaultProfileDir = isDev
    ? path.join(appRoot, 'Profiles', DEFAULT_PROFILE_ID)
    : appRoot;

  if (profileId !== DEFAULT_PROFILE_ID) {
    ensureProfile(appRoot, DEFAULT_PROFILE_ID, {
      checkoutHash,
      defaultProfileDir,
      dev: isDev,
      now: options.now,
    });
  }

  const { catalogPath, record, metadata } = ensureProfile(appRoot, profileId, {
    checkoutHash,
    defaultProfileDir,
    dev: isDev,
    now: options.now,
  });

  return {
    id: metadata.id,
    displayName: metadata.displayName,
    source: 'catalog',
    appRoot,
    userDataDir: record.dir,
    isDev,
    repoRoot,
    checkoutHash,
    catalogPath,
    metadata,
  };
}

function applyProfile(app, profile) {
  if (app.setPath) {
    app.setPath('userData', profile.userDataDir);
    app.setPath('crashDumps', path.join(profile.userDataDir, 'crash-reports'));
  }
}

function getLegacyDevDataDirs(profile) {
  if (!profile?.isDev || !profile.repoRoot) return [];

  return LEGACY_DEV_DATA_DIRS
    .map((dirName) => path.join(profile.repoRoot, dirName))
    .filter((dirPath) => fs.existsSync(dirPath));
}

function warnAboutLegacyDevData(profile, options = {}) {
  const legacyDirs = getLegacyDevDataDirs(profile);
  if (!legacyDirs.length || !profile?.appRoot) {
    return { warned: false, paths: legacyDirs };
  }

  const markerPath = path.join(profile.appRoot, LEGACY_DEV_DATA_WARNING_FILE);
  if (fs.existsSync(markerPath) && options.force !== true) {
    return { warned: false, paths: legacyDirs, markerPath };
  }

  const logger = options.logger || console;
  logger.warn?.(
    '[profile] Legacy repo-root dev data detected. Freedom Dev profiles ignore these directories by default:',
    legacyDirs
  );
  logger.warn?.(
    '[profile] To intentionally reuse old dev data, point FREEDOM_DEV_HOME or explicit data-path overrides at the desired location.'
  );

  try {
    fs.mkdirSync(profile.appRoot, { recursive: true });
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          warnedAt: new Date().toISOString(),
          repoRoot: profile.repoRoot,
          paths: legacyDirs,
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch (error) {
    logger.warn?.('[profile] Failed to write legacy dev data warning marker:', error.message);
  }

  return { warned: true, paths: legacyDirs, markerPath };
}

function initializeProfile(app, options = {}) {
  activeProfile = resolveProfile(app, options);
  applyProfile(app, activeProfile);
  return activeProfile;
}

function getActiveProfile() {
  return activeProfile;
}

function updateActiveProfileNodeConfig(protocol, updates) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  const result = updateProfileNodeConfig(activeProfile, protocol, updates);
  if (result?.metadata) {
    activeProfile.metadata = result.metadata;
  }
  return result;
}

function getProfileCatalogOptions(profile = activeProfile) {
  if (!profile || profile.source !== 'catalog') {
    return null;
  }

  return {
    checkoutHash: profile.checkoutHash,
    dev: profile.isDev === true,
  };
}

function listProfilesForActiveApp() {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  return listProfileSummaries(activeProfile.appRoot, {
    activeProfileId: activeProfile.id,
  });
}

function createProfileForActiveApp(input) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  return createProfile(activeProfile.appRoot, input, getProfileCatalogOptions());
}

function renameProfileForActiveApp(profileId, displayName) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  const result = renameProfile(activeProfile.appRoot, profileId, displayName);
  if (result?.metadata && profileId === activeProfile.id) {
    activeProfile = {
      ...activeProfile,
      displayName: result.metadata.displayName,
      metadata: result.metadata,
    };
  }
  return result;
}

function deleteProfileForActiveApp(profileId, expectedDisplayName) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  if (profileId === activeProfile.id) {
    throw new Error('The active profile cannot be deleted');
  }

  return deleteProfile(activeProfile.appRoot, profileId, expectedDisplayName);
}

module.exports = {
  LEGACY_DEV_DATA_DIRS,
  LEGACY_DEV_DATA_WARNING_FILE,
  applyProfile,
  createProfileForActiveApp,
  deleteProfileForActiveApp,
  findRepoRoot,
  getActiveProfile,
  getArgValue,
  getDefaultRepoRoot,
  getLegacyDevDataDirs,
  initializeProfile,
  listProfilesForActiveApp,
  renameProfileForActiveApp,
  resolveProfile,
  updateActiveProfileNodeConfig,
  warnAboutLegacyDevData,
};
