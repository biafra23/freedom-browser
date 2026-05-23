const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock electron with IPC capture
const ipcHandlers = {};
jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const mockGetDerivedKeys = jest.fn();
const mockGetPublisherKey = jest.fn();

jest.mock('../identity-manager', () => ({
  getDerivedKeys: (...args) => mockGetDerivedKeys(...args),
  getPublisherKey: (...args) => mockGetPublisherKey(...args),
}));

const { app } = require('electron');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-store-test-'));
  app.getPath.mockReturnValue(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const IPC = require('../../shared/ipc-channels');

const {
  getOriginEntry,
  setOriginEntry,
  allocatePublisherKeyIndex,
  getOriginIdentityState,
  createAppScopedIdentity,
  ensureBeeWalletIdentity,
  activateIdentity,
  getFeed,
  setFeed,
  updateFeedReference,
  getAllFeeds,
  getAllOriginEntries,
  hasIdentityMode,
  hasFeedGrant,
  grantFeedAccess,
  revokeFeedAccess,
  registerFeedStoreIpc,
  _resetCache,
} = require('./feed-store');

beforeEach(() => {
  _resetCache();
  mockGetDerivedKeys.mockReturnValue({
    beeWallet: {
      address: '0xBee0000000000000000000000000000000000000',
      privateKey: '0xbeekey',
    },
  });
  mockGetPublisherKey.mockImplementation(async (index) => ({
    address: `0xPublisher${index}`,
    privateKey: `0xpublisher${index}`,
  }));
});

function getFeedsFilePath() {
  return path.join(tmpDir, 'swarm-feeds.json');
}

function readFeedsFile() {
  return JSON.parse(fs.readFileSync(getFeedsFilePath(), 'utf-8'));
}

describe('feed-store', () => {
  describe('origin entries', () => {
    test('getOriginEntry returns null for unknown origin', () => {
      expect(getOriginEntry('unknown.eth')).toBeNull();
    });

    test('setOriginEntry creates entry with app-scoped mode', () => {
      const entry = setOriginEntry('myapp.eth', {
        identityMode: 'app-scoped',
        publisherKeyIndex: 0,
      });
      expect(entry.identityMode).toBe('app-scoped');
      expect(entry.publisherKeyIndex).toBe(0);
      expect(entry.activeIdentityId).toBe('app-scoped:0');
      expect(entry.identities['app-scoped:0']).toMatchObject({
        mode: 'app-scoped',
        publisherKeyIndex: 0,
      });
      expect(entry.grantedAt).toEqual(expect.any(Number));
      expect(entry.feeds).toEqual({});
    });

    test('setOriginEntry creates entry with bee-wallet mode', () => {
      const entry = setOriginEntry('myapp.eth', {
        identityMode: 'bee-wallet',
      });
      expect(entry.identityMode).toBe('bee-wallet');
      expect(entry.publisherKeyIndex).toBeNull();
      expect(entry.activeIdentityId).toBe('bee-wallet');
    });

    test('getOriginEntry returns entry after set', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      const entry = getOriginEntry('myapp.eth');
      expect(entry).not.toBeNull();
      expect(entry.identityMode).toBe('app-scoped');
    });

    test('setOriginEntry preserves existing feeds on update', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      setFeed('myapp.eth', 'blog', {
        topic: 'abc',
        owner: 'def',
        manifestReference: '123',
      });
      // Update identity mode (shouldn't happen in practice, but tests preservation)
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      expect(getFeed('myapp.eth', 'blog')).not.toBeNull();
    });

    test('setOriginEntry normalizes origin', () => {
      setOriginEntry('bzz://ABC123/path', { identityMode: 'bee-wallet' });
      expect(getOriginEntry('bzz://ABC123')).not.toBeNull();
    });
  });

  describe('publisher key index allocation', () => {
    test('allocates indices sequentially starting from 0', () => {
      expect(allocatePublisherKeyIndex()).toBe(0);
      expect(allocatePublisherKeyIndex()).toBe(1);
      expect(allocatePublisherKeyIndex()).toBe(2);
    });

    test('indices persist across cache reset', () => {
      allocatePublisherKeyIndex(); // 0
      allocatePublisherKeyIndex(); // 1
      _resetCache();
      expect(allocatePublisherKeyIndex()).toBe(2);
    });
  });

  describe('identity management', () => {
    test('getOriginIdentityState lists identities for an origin', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      const state = getOriginIdentityState('myapp.eth');

      expect(state.origin).toBe('myapp.eth');
      expect(state.activeIdentityId).toBe('app-scoped:0');
      expect(state.identities).toHaveLength(1);
      expect(state.identities[0]).toMatchObject({
        id: 'app-scoped:0',
        mode: 'app-scoped',
      });
    });

    test('createAppScopedIdentity adds and activates a new identity without dropping old identities', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      const entry = createAppScopedIdentity('myapp.eth', { label: '  Testing identity  ' });

      expect(entry.activeIdentityId).toBe('app-scoped:1');
      expect(entry.identities['app-scoped:0']).toBeDefined();
      expect(entry.identities['app-scoped:1']).toMatchObject({
        mode: 'app-scoped',
        publisherKeyIndex: 1,
        label: 'Testing identity',
      });
      expect(allocatePublisherKeyIndex()).toBe(2);
    });

    test('ensureBeeWalletIdentity can add Bee wallet without activating it', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      const entry = ensureBeeWalletIdentity('myapp.eth');

      expect(entry.activeIdentityId).toBe('app-scoped:0');
      expect(entry.identities['bee-wallet']).toMatchObject({
        mode: 'bee-wallet',
        publisherKeyIndex: null,
      });
    });

    test('ensureBeeWalletIdentity can activate Bee wallet identity', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      const entry = ensureBeeWalletIdentity('myapp.eth', { activate: true });

      expect(entry.activeIdentityId).toBe('bee-wallet');
      expect(entry.identityMode).toBe('bee-wallet');
      expect(entry.publisherKeyIndex).toBeNull();
    });

    test('activateIdentity switches active identity without retagging existing feeds', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });
      createAppScopedIdentity('myapp.eth');

      const entry = activateIdentity('myapp.eth', 'app-scoped:0');

      expect(entry.activeIdentityId).toBe('app-scoped:0');
      expect(getFeed('myapp.eth', 'blog').identityId).toBe('app-scoped:0');
    });

    test('activateIdentity rejects unknown identities', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      expect(() => activateIdentity('myapp.eth', 'missing')).toThrow('Publisher identity not found');
    });
  });

  describe('feed entries', () => {
    beforeEach(() => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
    });

    test('getFeed returns null for unknown feed', () => {
      expect(getFeed('myapp.eth', 'unknown')).toBeNull();
    });

    test('getFeed returns null for unknown origin', () => {
      expect(getFeed('unknown.eth', 'blog')).toBeNull();
    });

    test('setFeed creates feed entry', () => {
      const feed = setFeed('myapp.eth', 'blog', {
        topic: 'abc123',
        owner: 'def456',
        manifestReference: '789abc',
      });
      expect(feed.topic).toBe('abc123');
      expect(feed.owner).toBe('def456');
      expect(feed.manifestReference).toBe('789abc');
      expect(feed.identityId).toBe('app-scoped:0');
      expect(feed.createdAt).toEqual(expect.any(Number));
      expect(feed.lastUpdated).toBeNull();
      expect(feed.lastReference).toBeNull();
    });

    test('setFeed is idempotent — preserves createdAt', () => {
      const realDateNow = Date.now;
      Date.now = () => 1000;
      try {
        setFeed('myapp.eth', 'blog', {
          topic: 'abc',
          owner: 'def',
          manifestReference: '123',
        });
        Date.now = () => 2000;
        setFeed('myapp.eth', 'blog', {
          topic: 'abc',
          owner: 'def',
          manifestReference: '123',
        });
        const feed = getFeed('myapp.eth', 'blog');
        expect(feed.createdAt).toBe(1000);
      } finally {
        Date.now = realDateNow;
      }
    });

    test('setFeed throws for unknown origin', () => {
      expect(() => setFeed('unknown.eth', 'blog', {
        topic: 'abc',
        owner: 'def',
        manifestReference: '123',
      })).toThrow('No origin entry');
    });

    test('getFeed returns entry after set', () => {
      setFeed('myapp.eth', 'blog', {
        topic: 'abc',
        owner: 'def',
        manifestReference: '123',
      });
      const feed = getFeed('myapp.eth', 'blog');
      expect(feed).not.toBeNull();
      expect(feed.topic).toBe('abc');
    });

    test('updateFeedReference updates lastReference and lastUpdated', () => {
      setFeed('myapp.eth', 'blog', {
        topic: 'abc',
        owner: 'def',
        manifestReference: '123',
      });
      updateFeedReference('myapp.eth', 'blog', 'newref456');
      const feed = getFeed('myapp.eth', 'blog');
      expect(feed.lastReference).toBe('newref456');
      expect(feed.lastUpdated).toEqual(expect.any(Number));
    });

    test('updateFeedReference throws for unknown feed', () => {
      expect(() => updateFeedReference('myapp.eth', 'unknown', 'ref')).toThrow('not found');
    });

    test('getAllFeeds returns all feeds for origin', () => {
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });
      setFeed('myapp.eth', 'profile', { topic: 'd', owner: 'e', manifestReference: 'f' });
      const feeds = getAllFeeds('myapp.eth');
      expect(Object.keys(feeds)).toHaveLength(2);
      expect(feeds.blog).toBeDefined();
      expect(feeds.profile).toBeDefined();
    });

    test('getAllFeeds returns empty object for unknown origin', () => {
      expect(getAllFeeds('unknown.eth')).toEqual({});
    });
  });

  describe('persistence', () => {
    test('data survives cache reset', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });
      _resetCache();
      const feed = getFeed('myapp.eth', 'blog');
      expect(feed).not.toBeNull();
      expect(feed.topic).toBe('a');
    });

    test('mutating returned origin entry does not corrupt cache', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });

      const entry = getOriginEntry('myapp.eth');
      // Mutate the returned object at every level
      entry.identityMode = 'corrupted';
      entry.identities['app-scoped:0'].mode = 'corrupted';
      entry.feeds.blog.owner = 'corrupted';
      entry.feeds.newFeed = { topic: 'injected' };

      // Cache should be unaffected
      const fresh = getOriginEntry('myapp.eth');
      expect(fresh.identityMode).toBe('app-scoped');
      expect(fresh.identities['app-scoped:0'].mode).toBe('app-scoped');
      expect(fresh.feeds.blog.owner).toBe('b');
      expect(fresh.feeds.newFeed).toBeUndefined();
    });

    test('writes to disk', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet' });
      const filePath = getFeedsFilePath();
      expect(fs.existsSync(filePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.version).toBe(2);
      expect(data.origins['myapp.eth']).toBeDefined();
      expect(data.origins['myapp.eth'].activeIdentityId).toBe('bee-wallet');
    });
  });

  describe('store migration', () => {
    test('migrates v1 app-scoped origin entries to v2 identities', () => {
      fs.writeFileSync(getFeedsFilePath(), JSON.stringify({
        version: 1,
        nextPublisherKeyIndex: 7,
        origins: {
          'myapp.eth': {
            identityMode: 'app-scoped',
            publisherKeyIndex: 3,
            feedGranted: true,
            grantedAt: 1234,
            feeds: {
              blog: {
                topic: 'topic',
                owner: 'owner',
                manifestReference: 'manifest',
                createdAt: 1300,
                lastUpdated: 1400,
                lastReference: 'reference',
              },
            },
          },
        },
      }), 'utf-8');

      const entry = getOriginEntry('myapp.eth');
      expect(entry.identityMode).toBe('app-scoped');
      expect(entry.publisherKeyIndex).toBe(3);
      expect(entry.activeIdentityId).toBe('app-scoped:3');
      expect(entry.identities['app-scoped:3']).toMatchObject({
        id: 'app-scoped:3',
        mode: 'app-scoped',
        publisherKeyIndex: 3,
        label: 'App-scoped identity 4',
        createdAt: 1234,
      });
      expect(entry.feeds.blog.identityId).toBe('app-scoped:3');

      const persisted = readFeedsFile();
      expect(persisted.version).toBe(2);
      expect(persisted.nextPublisherKeyIndex).toBe(7);
      expect(persisted.origins['myapp.eth'].feeds.blog.identityId).toBe('app-scoped:3');
      expect(fs.existsSync(path.join(tmpDir, 'swarm-feeds.v1-backup.json'))).toBe(true);
    });

    test('migrates v1 bee-wallet origin entries to v2 identities', () => {
      fs.writeFileSync(getFeedsFilePath(), JSON.stringify({
        version: 1,
        nextPublisherKeyIndex: 2,
        origins: {
          'beeapp.eth': {
            identityMode: 'bee-wallet',
            feedGranted: false,
            grantedAt: 2345,
            feeds: {},
          },
        },
      }), 'utf-8');

      const entry = getOriginEntry('beeapp.eth');
      expect(entry.identityMode).toBe('bee-wallet');
      expect(entry.publisherKeyIndex).toBeNull();
      expect(entry.activeIdentityId).toBe('bee-wallet');
      expect(entry.identities['bee-wallet']).toMatchObject({
        id: 'bee-wallet',
        mode: 'bee-wallet',
        publisherKeyIndex: null,
        label: 'Bee wallet identity',
      });
    });

    test('treats missing version as corrupt and starts fresh', () => {
      fs.writeFileSync(getFeedsFilePath(), JSON.stringify({
        nextPublisherKeyIndex: 99,
        origins: {
          'myapp.eth': {
            identityMode: 'app-scoped',
            publisherKeyIndex: 0,
          },
        },
      }), 'utf-8');

      expect(getOriginEntry('myapp.eth')).toBeNull();
      const persisted = readFeedsFile();
      expect(persisted).toEqual({
        version: 2,
        nextPublisherKeyIndex: 0,
        origins: {},
      });
      expect(fs.existsSync(path.join(tmpDir, 'swarm-feeds.corrupt.json'))).toBe(true);
    });

    test('treats unknown version as corrupt and starts fresh', () => {
      fs.writeFileSync(getFeedsFilePath(), JSON.stringify({
        version: 999,
        nextPublisherKeyIndex: 99,
        origins: {},
      }), 'utf-8');

      expect(getAllOriginEntries()).toEqual([]);
      const persisted = readFeedsFile();
      expect(persisted.version).toBe(2);
      expect(persisted.nextPublisherKeyIndex).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, 'swarm-feeds.corrupt.json'))).toBe(true);
    });
  });

  describe('hasIdentityMode', () => {
    test('returns false for unknown origin', () => {
      expect(hasIdentityMode('unknown.eth')).toBe(false);
    });

    test('returns true after identity set', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet' });
      expect(hasIdentityMode('myapp.eth')).toBe(true);
    });
  });

  describe('feed grant lifecycle', () => {
    test('hasFeedGrant returns false for unknown origin', () => {
      expect(hasFeedGrant('unknown.eth')).toBe(false);
    });

    test('hasFeedGrant returns false after setOriginEntry without feedGranted', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet' });
      expect(hasFeedGrant('myapp.eth')).toBe(false);
    });

    test('hasFeedGrant returns true after setOriginEntry with feedGranted', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet', feedGranted: true });
      expect(hasFeedGrant('myapp.eth')).toBe(true);
    });

    test('grantFeedAccess sets feedGranted to true', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      expect(hasFeedGrant('myapp.eth')).toBe(false);
      grantFeedAccess('myapp.eth');
      expect(hasFeedGrant('myapp.eth')).toBe(true);
    });

    test('revokeFeedAccess clears feedGranted but preserves identity', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0, feedGranted: true });
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });

      revokeFeedAccess('myapp.eth');

      expect(hasFeedGrant('myapp.eth')).toBe(false);
      // Identity metadata preserved
      expect(hasIdentityMode('myapp.eth')).toBe(true);
      const entry = getOriginEntry('myapp.eth');
      expect(entry.identityMode).toBe('app-scoped');
      expect(entry.publisherKeyIndex).toBe(0);
      // Feeds preserved
      expect(getFeed('myapp.eth', 'blog')).not.toBeNull();
    });

    test('re-granting after revoke uses same identity', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 5, feedGranted: true });
      revokeFeedAccess('myapp.eth');
      grantFeedAccess('myapp.eth');

      const entry = getOriginEntry('myapp.eth');
      expect(entry.feedGranted).toBe(true);
      expect(entry.publisherKeyIndex).toBe(5); // Same key, not re-allocated
    });

    test('feedGranted survives cache reset', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet', feedGranted: true });
      _resetCache();
      expect(hasFeedGrant('myapp.eth')).toBe(true);
    });
  });

  describe('IPC handlers', () => {
    beforeAll(() => {
      registerFeedStoreIpc();
    });

    test('registers expected channels', () => {
      expect(ipcHandlers[IPC.SWARM_HAS_FEED_IDENTITY]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_GET_ORIGIN_IDENTITIES]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_CREATE_APP_SCOPED_IDENTITY]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_ENSURE_BEE_WALLET_IDENTITY]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_ACTIVATE_FEED_IDENTITY]).toBeDefined();
    });

    test('has-feed-identity returns false for unknown origin', () => {
      _resetCache();
      const result = ipcHandlers[IPC.SWARM_HAS_FEED_IDENTITY]({}, 'unknown.eth');
      expect(result).toBe(false);
    });

    test('set-feed-identity creates origin entry with app-scoped mode', () => {
      _resetCache();
      const result = ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-test.eth', 'app-scoped');
      expect(result.identityMode).toBe('app-scoped');
      expect(result.publisherKeyIndex).toEqual(expect.any(Number));
    });

    test('set-feed-identity is idempotent — does not allocate new key index', () => {
      _resetCache();
      const first = ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-idem.eth', 'app-scoped');
      const firstIndex = first.publisherKeyIndex;
      const second = ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-idem.eth', 'app-scoped');
      expect(second.publisherKeyIndex).toBe(firstIndex);
    });

    test('set-feed-identity ignores different mode on re-grant', () => {
      _resetCache();
      ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-mode.eth', 'app-scoped');
      const second = ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-mode.eth', 'bee-wallet');
      // Should return existing entry, not switch mode
      expect(second.identityMode).toBe('app-scoped');
    });

    test('set-feed-identity rejects invalid identity mode', () => {
      _resetCache();
      expect(() => ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-bad.eth', 'invalid'))
        .toThrow('Invalid identity mode');
    });

    test('has-feed-identity returns true after identity set', () => {
      _resetCache();
      ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-test2.eth', 'bee-wallet');
      const result = ipcHandlers[IPC.SWARM_HAS_FEED_IDENTITY]({}, 'ipc-test2.eth');
      expect(result).toBe(true);
    });

    test('set-feed-identity also grants feed access', () => {
      _resetCache();
      ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-grant.eth', 'app-scoped');
      expect(hasFeedGrant('ipc-grant.eth')).toBe(true);
    });

    test('revoke-feed-access clears feed grant', () => {
      _resetCache();
      ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-revoke.eth', 'bee-wallet');
      expect(hasFeedGrant('ipc-revoke.eth')).toBe(true);
      ipcHandlers[IPC.SWARM_REVOKE_FEED_ACCESS]({}, 'ipc-revoke.eth');
      expect(hasFeedGrant('ipc-revoke.eth')).toBe(false);
      // Identity preserved
      expect(hasIdentityMode('ipc-revoke.eth')).toBe(true);
    });

    test('set-feed-identity re-grants after revocation without new key', () => {
      _resetCache();
      const first = ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-regrant.eth', 'app-scoped');
      ipcHandlers[IPC.SWARM_REVOKE_FEED_ACCESS]({}, 'ipc-regrant.eth');
      const second = ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-regrant.eth', 'app-scoped');
      expect(second.feedGranted).toBe(true);
      expect(second.publisherKeyIndex).toBe(first.publisherKeyIndex);
    });

    test('identity management IPC creates, ensures, and activates identities', async () => {
      _resetCache();
      ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-manage.eth', 'app-scoped');

      const withNewIdentity = await ipcHandlers[IPC.SWARM_CREATE_APP_SCOPED_IDENTITY]({}, 'ipc-manage.eth', {
        label: 'Second identity',
      });
      expect(withNewIdentity.activeIdentityId).toBe('app-scoped:1');
      expect(withNewIdentity.identities.find((identity) => identity.id === 'app-scoped:1')).toMatchObject({
        label: 'Second identity',
        owner: '0xPublisher1',
        stored: true,
      });

      const withBeeIdentity = await ipcHandlers[IPC.SWARM_ENSURE_BEE_WALLET_IDENTITY]({}, 'ipc-manage.eth');
      expect(withBeeIdentity.activeIdentityId).toBe('app-scoped:1');
      expect(withBeeIdentity.identities.find((identity) => identity.id === 'bee-wallet')).toMatchObject({
        owner: '0xBee0000000000000000000000000000000000000',
        stored: true,
      });

      const switched = await ipcHandlers[IPC.SWARM_ACTIVATE_FEED_IDENTITY]({}, 'ipc-manage.eth', 'bee-wallet');
      expect(switched.activeIdentityId).toBe('bee-wallet');
      expect(switched.identityMode).toBe('bee-wallet');

      const state = await ipcHandlers[IPC.SWARM_GET_ORIGIN_IDENTITIES]({}, 'ipc-manage.eth');
      expect(state.activeIdentityId).toBe('bee-wallet');
      expect(state.identities.map((identity) => identity.id)).toEqual([
        'app-scoped:0',
        'app-scoped:1',
        'bee-wallet',
      ]);
    });

    test('get-origin-identities includes Bee wallet as an available identity', async () => {
      _resetCache();
      ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-available.eth', 'app-scoped');

      const state = await ipcHandlers[IPC.SWARM_GET_ORIGIN_IDENTITIES]({}, 'ipc-available.eth');
      const beeIdentity = state.identities.find((identity) => identity.id === 'bee-wallet');

      expect(beeIdentity).toMatchObject({
        mode: 'bee-wallet',
        owner: '0xBee0000000000000000000000000000000000000',
        stored: false,
      });
    });

    test('get-origin-identities requires unlocked vault for owner inspection', async () => {
      _resetCache();
      ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, 'ipc-locked.eth', 'app-scoped');
      mockGetDerivedKeys.mockReturnValue(null);

      await expect(ipcHandlers[IPC.SWARM_GET_ORIGIN_IDENTITIES]({}, 'ipc-locked.eth'))
        .rejects.toThrow('Vault must be unlocked');
    });
  });
});
