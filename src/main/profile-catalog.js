const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROFILE_REGISTRY_FILE = 'profile-registry.json';
const PROFILE_META_FILE = 'profile.json';
const DEFAULT_PROFILE_ID = 'default';

const PACKAGED_PORT_BASE = {
  beeApi: 11633,
  ipfsApi: 15001,
  ipfsGateway: 18080,
  radicleHttp: 18780,
  radicleP2p: 18776,
};

const DEV_PORT_BASE = {
  beeApi: 21633,
  ipfsApi: 25001,
  ipfsGateway: 28080,
  radicleHttp: 28780,
  radicleP2p: 28776,
};

function sanitizeProfileId(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) {
    throw new Error('Profile id is required');
  }

  if (input === '.' || input === '..' || input.includes('/') || input.includes('\\')) {
    throw new Error(`Invalid profile id: ${value}`);
  }

  const id = input.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id || id === '.' || id === '..') {
    throw new Error(`Invalid profile id: ${value}`);
  }

  return id;
}

function displayNameFromId(profileId) {
  if (profileId === DEFAULT_PROFILE_ID) return 'Default';
  return profileId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || profileId;
}

function hashPath(targetPath) {
  return crypto.createHash('sha256').update(targetPath).digest('hex').slice(0, 8);
}

function getCheckoutId(repoRoot) {
  return `freedom-browser-${hashPath(repoRoot)}`;
}

function getDevPortOffset(checkoutHash) {
  return (parseInt(checkoutHash, 16) % 100) * 10;
}

function getManagedPorts(slot, options = {}) {
  const dev = options.dev === true;
  const base = dev ? DEV_PORT_BASE : PACKAGED_PORT_BASE;
  const offset = dev ? getDevPortOffset(options.checkoutHash || '00000000') : 0;

  return {
    beeApi: base.beeApi + offset + slot,
    ipfsApi: base.ipfsApi + offset + slot,
    ipfsGateway: base.ipfsGateway + offset + slot,
    radicleHttp: base.radicleHttp + offset + slot,
    radicleP2p: base.radicleP2p + offset + slot,
  };
}

function buildNodeConfig(ports) {
  return {
    bee: {
      mode: 'managed',
      apiPort: ports.beeApi,
      externalApi: null,
    },
    ipfs: {
      mode: 'managed',
      apiPort: ports.ipfsApi,
      gatewayPort: ports.ipfsGateway,
      externalApi: null,
      externalGateway: null,
    },
    radicle: {
      mode: 'managed',
      httpPort: ports.radicleHttp,
      p2pPort: ports.radicleP2p,
      externalHttp: null,
    },
  };
}

function getCatalogPath(appRoot) {
  return path.join(appRoot, PROFILE_REGISTRY_FILE);
}

function getProfileMetaPath(profileDir) {
  return path.join(profileDir, PROFILE_META_FILE);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function loadCatalog(appRoot) {
  const catalogPath = getCatalogPath(appRoot);
  if (!fs.existsSync(catalogPath)) {
    return { version: 1, profiles: [] };
  }

  const parsed = readJson(catalogPath);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
    throw new Error(`Unsupported profile catalog: ${catalogPath}`);
  }

  return parsed;
}

function saveCatalog(appRoot, catalog) {
  writeJsonAtomic(getCatalogPath(appRoot), catalog);
}

function findProfile(catalog, profileId) {
  return catalog.profiles.find((profile) => profile.id === profileId) || null;
}

function getProfileDir(appRoot, profileId, options = {}) {
  if (profileId === DEFAULT_PROFILE_ID && options.defaultProfileDir) {
    return options.defaultProfileDir;
  }
  return path.join(appRoot, 'Profiles', profileId);
}

function getUsedSlots(catalog) {
  return new Set(
    catalog.profiles
      .map((profile) => profile.slot)
      .filter((slot) => Number.isInteger(slot) && slot >= 0)
  );
}

function allocateSlot(catalog, profileId) {
  if (profileId === DEFAULT_PROFILE_ID) return 0;

  const used = getUsedSlots(catalog);
  let slot = 1;
  while (used.has(slot)) {
    slot += 1;
  }
  return slot;
}

function createProfileRecord(appRoot, profileId, options = {}) {
  const now = options.now || new Date().toISOString();
  const slot = options.slot ?? allocateSlot(options.catalog, profileId);
  const ports = getManagedPorts(slot, {
    dev: options.dev,
    checkoutHash: options.checkoutHash,
  });
  const displayName = options.displayName || displayNameFromId(profileId);
  const dir = getProfileDir(appRoot, profileId, options);

  return {
    id: profileId,
    displayName,
    dir,
    slot,
    createdAt: now,
    lastOpenedAt: now,
    nodes: buildNodeConfig(ports),
  };
}

function createProfileMetadata(record) {
  return {
    version: 1,
    id: record.id,
    displayName: record.displayName,
    createdAt: record.createdAt,
    lastOpenedAt: record.lastOpenedAt,
    slot: record.slot,
    nodes: record.nodes,
  };
}

function writeProfileMetadata(profileDir, metadata) {
  ensureDir(profileDir);
  writeJsonAtomic(getProfileMetaPath(profileDir), metadata);
}

function readProfileMetadata(profileDir) {
  const metaPath = getProfileMetaPath(profileDir);
  if (!fs.existsSync(metaPath)) return null;
  return readJson(metaPath);
}

function createProfile(appRoot, profileInput = {}, options = {}) {
  const displayName = String(profileInput.displayName || '').trim();
  const profileId = sanitizeProfileId(profileInput.id || displayName);
  if (!displayName) {
    throw new Error('Profile display name is required');
  }

  const catalog = loadCatalog(appRoot);
  if (findProfile(catalog, profileId)) {
    throw new Error(`Profile already exists: ${profileId}`);
  }

  const record = createProfileRecord(appRoot, profileId, {
    ...options,
    catalog,
    displayName,
  });
  catalog.profiles.push(record);
  saveCatalog(appRoot, catalog);

  const metadata = createProfileMetadata(record);
  writeProfileMetadata(record.dir, metadata);

  return {
    catalog,
    record,
    metadata,
  };
}

function renameProfile(appRoot, profileId, displayName) {
  const id = sanitizeProfileId(profileId);
  const nextDisplayName = String(displayName || '').trim();
  if (!nextDisplayName) {
    throw new Error('Profile display name is required');
  }

  const catalog = loadCatalog(appRoot);
  const record = findProfile(catalog, id);
  if (!record) {
    throw new Error(`Profile not found: ${id}`);
  }

  record.displayName = nextDisplayName;
  saveCatalog(appRoot, catalog);

  const existingMetadata = readProfileMetadata(record.dir) || createProfileMetadata(record);
  const metadata = {
    ...existingMetadata,
    id: record.id,
    displayName: nextDisplayName,
  };
  writeProfileMetadata(record.dir, metadata);

  return {
    catalog,
    record,
    metadata,
  };
}

function deleteProfile(appRoot, profileId, expectedDisplayName) {
  const id = sanitizeProfileId(profileId);
  if (id === DEFAULT_PROFILE_ID) {
    throw new Error('The default profile cannot be deleted');
  }

  const catalog = loadCatalog(appRoot);
  const recordIndex = catalog.profiles.findIndex((profile) => profile.id === id);
  if (recordIndex === -1) {
    throw new Error(`Profile not found: ${id}`);
  }

  const record = catalog.profiles[recordIndex];
  const displayName = record.displayName || displayNameFromId(record.id);
  if (String(expectedDisplayName || '') !== displayName) {
    throw new Error('Profile display name confirmation did not match');
  }

  const resolvedAppRoot = path.resolve(appRoot);
  const resolvedProfileDir = path.resolve(record.dir);
  if (
    resolvedProfileDir === resolvedAppRoot ||
    !resolvedProfileDir.startsWith(`${resolvedAppRoot}${path.sep}`)
  ) {
    throw new Error('Refusing to delete a profile outside the app data root');
  }

  catalog.profiles.splice(recordIndex, 1);
  saveCatalog(appRoot, catalog);
  fs.rmSync(resolvedProfileDir, { recursive: true, force: true });

  return {
    catalog,
    record,
  };
}

function listProfileSummaries(appRoot, options = {}) {
  const catalog = loadCatalog(appRoot);
  return catalog.profiles.map((record) => {
    const metadata = readProfileMetadata(record.dir) || createProfileMetadata(record);
    return {
      id: metadata.id || record.id,
      displayName: metadata.displayName || record.displayName || displayNameFromId(record.id),
      slot: Number.isInteger(metadata.slot) ? metadata.slot : record.slot,
      createdAt: metadata.createdAt || record.createdAt || null,
      lastOpenedAt: metadata.lastOpenedAt || record.lastOpenedAt || null,
      nodes: metadata.nodes || record.nodes || null,
      isActive: options.activeProfileId === record.id,
    };
  });
}

function updateProfileNodeConfig(profile, protocol, updates) {
  if (!profile?.appRoot || !profile?.userDataDir || !profile?.id || !profile?.metadata) {
    return null;
  }

  if (!['bee', 'ipfs', 'radicle'].includes(protocol)) {
    throw new Error(`Unsupported profile node protocol: ${protocol}`);
  }

  const catalog = loadCatalog(profile.appRoot);
  const record = findProfile(catalog, profile.id);

  if (record) {
    record.nodes = record.nodes || {};
    record.nodes[protocol] = {
      ...(record.nodes[protocol] || {}),
      ...updates,
    };
    saveCatalog(profile.appRoot, catalog);
  }

  const metaPath = getProfileMetaPath(profile.userDataDir);
  const metadata = fs.existsSync(metaPath)
    ? readJson(metaPath)
    : { ...profile.metadata };

  metadata.nodes = metadata.nodes || {};
  metadata.nodes[protocol] = {
    ...(metadata.nodes[protocol] || {}),
    ...updates,
  };
  writeProfileMetadata(profile.userDataDir, metadata);

  return {
    catalog,
    record,
    metadata,
  };
}

function ensureProfile(appRoot, profileId, options = {}) {
  ensureDir(appRoot);

  const catalog = loadCatalog(appRoot);
  let record = findProfile(catalog, profileId);

  if (!record) {
    record = createProfileRecord(appRoot, profileId, {
      ...options,
      catalog,
    });
    catalog.profiles.push(record);
    saveCatalog(appRoot, catalog);
  }

  ensureDir(record.dir);

  const metaPath = getProfileMetaPath(record.dir);
  let metadata;
  if (fs.existsSync(metaPath)) {
    metadata = readJson(metaPath);
  } else {
    metadata = createProfileMetadata(record);
    writeProfileMetadata(record.dir, metadata);
  }

  return {
    catalog,
    catalogPath: getCatalogPath(appRoot),
    record,
    metadata,
  };
}

module.exports = {
  DEFAULT_PROFILE_ID,
  DEV_PORT_BASE,
  PACKAGED_PORT_BASE,
  PROFILE_META_FILE,
  PROFILE_REGISTRY_FILE,
  allocateSlot,
  createProfile,
  createProfileMetadata,
  deleteProfile,
  displayNameFromId,
  ensureProfile,
  getCatalogPath,
  getCheckoutId,
  getDevPortOffset,
  getManagedPorts,
  getProfileMetaPath,
  hashPath,
  listProfileSummaries,
  loadCatalog,
  renameProfile,
  readProfileMetadata,
  sanitizeProfileId,
  saveCatalog,
  updateProfileNodeConfig,
  writeProfileMetadata,
};
