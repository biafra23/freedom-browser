jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const runtime = require('./messaging-runtime');

// ---------------------------------------------------------------------------
// Mock factories — reused across tests
// ---------------------------------------------------------------------------

function makeMockXmtpClient(client = {}) {
  return {
    start: jest.fn(async ({ address, env }) => ({
      address,
      env,
      inboxId: `inbox-${address}`,
      installationId: `install-${address}`,
      dbPath: `/tmp/xmtp-${env}.db3`,
    })),
    stop: jest.fn(),
    getClient: jest.fn(() => client),
    getInfo: jest.fn(() => null),
    isStarted: jest.fn(() => true),
  };
}

function makeChannelObj({ id, name = null, members = [], onSubscribe } = {}) {
  return {
    id,
    members: jest.fn(async () => members.slice()),
    publish: jest.fn(async () => `msg-${Math.random().toString(36).slice(2, 8)}`),
    messages: jest.fn(async () => []),
    subscribe: jest.fn(async (handler) => {
      onSubscribe?.(handler);
      return jest.fn(async () => {});
    }),
    _group: { name },
  };
}

function makeMockChannelMod({ existingChannels = [], openByIdImpl, createImpl } = {}) {
  return {
    listChannels: jest.fn(async () => existingChannels.slice()),
    openChannelById: jest.fn(openByIdImpl || (async () => null)),
    createChannelByAddresses: jest.fn(
      createImpl ||
        (async (_client, { memberAddresses, name }) =>
          makeChannelObj({
            id: `g-${memberAddresses[0]}`,
            name: name || null,
            members: ['inbox-self', `inbox-${memberAddresses[0]}`],
          }))
    ),
  };
}

function makeMockLobbyClient(impl, { readLobbyCacheImpl } = {}) {
  return {
    ensureLobbyMembership: jest.fn(impl || (async () => null)),
    readLobbyCache: jest.fn(readLobbyCacheImpl || (() => null)),
  };
}

function applyOverrides({ xmtp, channelMod, lobby } = {}) {
  runtime._setOverridesForTesting({
    xmtpClient: xmtp,
    channelMod,
    lobbyClient: lobby || makeMockLobbyClient(),
  });
}

beforeEach(() => {
  runtime._resetForTesting();
});

// ---------------------------------------------------------------------------
// start() / stop() / getStatus()
// ---------------------------------------------------------------------------

describe('start/stop/getStatus', () => {
  test('reports unstarted state by default', () => {
    expect(runtime.getStatus()).toMatchObject({ started: false, address: null });
    expect(runtime.isStarted()).toBe(false);
  });

  test('start boots the client and exposes identity in status', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod();
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });

    const status = await runtime.start({
      privateKey: '0xabc',
      address: '0xAlice',
      dataDir: '/tmp/m',
      env: 'dev',
    });

    expect(xmtp.start).toHaveBeenCalledWith({
      privateKey: '0xabc',
      address: '0xAlice',
      dataDir: '/tmp/m',
      env: 'dev',
    });
    expect(status).toMatchObject({
      started: true,
      address: '0xAlice',
      inboxId: 'inbox-0xAlice',
      env: 'dev',
      error: null,
    });
    expect(runtime.isStarted()).toBe(true);
  });

  test('start failure sets error and leaves runtime unstarted', async () => {
    const xmtp = makeMockXmtpClient();
    xmtp.start.mockRejectedValueOnce(new Error('network down'));
    const channelMod = makeMockChannelMod();
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });

    const status = await runtime.start({ privateKey: '0xabc', address: '0xA', dataDir: '/tmp/m' });

    expect(status).toMatchObject({ started: false, error: 'network down' });
    expect(runtime.isStarted()).toBe(false);
  });

  test('start is idempotent for the same identity', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod();
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });

    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });
    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });

    expect(xmtp.start).toHaveBeenCalledTimes(1);
  });

  test('stop tears down subscriptions and clears identity', async () => {
    const ch = makeChannelObj({ id: 'c1', members: ['inbox-self'] });
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod({ existingChannels: [ch] });
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });

    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });
    // Allow background subscribeAllExistingChannels to run.
    await new Promise((r) => setImmediate(r));

    await runtime.stop();

    expect(xmtp.stop).toHaveBeenCalled();
    expect(runtime.getStatus()).toMatchObject({ started: false, address: null });
  });

  test('stop is safe to call before start', async () => {
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listChannels / createChannel
// ---------------------------------------------------------------------------

describe('listChannels', () => {
  test('rejects when not started', async () => {
    await expect(runtime.listChannels()).rejects.toThrow(/not started/i);
  });

  test('returns renderer-shaped channel summaries', async () => {
    const ch1 = makeChannelObj({
      id: 'c1',
      name: 'Alice',
      members: ['inbox-self', 'inbox-alice'],
    });
    const ch2 = makeChannelObj({ id: 'c2', name: null, members: ['inbox-self'] });
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod({ existingChannels: [ch1, ch2] });
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });

    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });
    await new Promise((r) => setImmediate(r));

    const list = await runtime.listChannels();
    expect(list).toEqual([
      {
        id: 'c1',
        name: 'Alice',
        memberCount: 2,
        memberInboxIds: ['inbox-self', 'inbox-alice'],
      },
      { id: 'c2', name: null, memberCount: 1, memberInboxIds: ['inbox-self'] },
    ]);
  });
});

describe('createChannel', () => {
  test('rejects when not started', async () => {
    await expect(runtime.createChannel({ peerAddresses: ['0xX'] })).rejects.toThrow(/not started/i);
  });

  test('rejects empty peerAddresses', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod();
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });
    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });

    await expect(runtime.createChannel({ peerAddresses: [] })).rejects.toThrow(
      /peerAddresses\[\] is required/
    );
  });

  test('forwards to channel.createChannelByAddresses and returns summary', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod();
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });
    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });

    const summary = await runtime.createChannel({
      peerAddresses: ['0xBob'],
      name: 'Bob',
    });

    expect(channelMod.createChannelByAddresses).toHaveBeenCalledWith(expect.anything(), {
      memberAddresses: ['0xBob'],
      name: 'Bob',
    });
    expect(summary).toMatchObject({
      id: 'g-0xBob',
      name: 'Bob',
      memberCount: 2,
      memberInboxIds: ['inbox-self', 'inbox-0xBob'],
    });
  });

  test('auto-subscribes the new channel', async () => {
    const ch = makeChannelObj({ id: 'g-new', name: 'X', members: ['inbox-self', 'inbox-bob'] });
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod({ createImpl: async () => ch });
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });
    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });

    await runtime.createChannel({ peerAddresses: ['0xBob'] });
    expect(ch.subscribe).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// publish / getChannelMessages
// ---------------------------------------------------------------------------

describe('publish', () => {
  test('opens channel by id and forwards payload', async () => {
    const ch = makeChannelObj({ id: 'ch1', members: ['inbox-self'] });
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod({
      openByIdImpl: async (_c, id) => (id === 'ch1' ? ch : null),
    });
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });
    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });

    const msgId = await runtime.publish('ch1', { hello: 'world' });
    expect(ch.publish).toHaveBeenCalledWith({ hello: 'world' });
    expect(typeof msgId).toBe('string');
  });

  test('throws when channel id is unknown', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod({ openByIdImpl: async () => null });
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });
    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });

    await expect(runtime.publish('nope', {})).rejects.toThrow(/channel not found/);
  });
});

describe('getChannelMessages', () => {
  test('forwards limit and returns messages', async () => {
    const sample = [
      { id: 'm1', from: 'inbox-bob', isOwn: false, parsed: { x: 1 } },
      { id: 'm2', from: 'inbox-self', isOwn: true, parsed: { x: 2 } },
    ];
    const ch = makeChannelObj({ id: 'ch1', members: ['inbox-self', 'inbox-bob'] });
    ch.messages.mockResolvedValue(sample);
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod({
      openByIdImpl: async () => ch,
    });
    runtime._setOverridesForTesting({ xmtpClient: xmtp, channelMod });
    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });

    const messages = await runtime.getChannelMessages('ch1', { limit: 25 });
    expect(ch.messages).toHaveBeenCalledWith({ limit: 25 });
    expect(messages).toEqual(sample);
  });
});

// ---------------------------------------------------------------------------
// addMessageListener — multi-listener fan-out
// ---------------------------------------------------------------------------

describe('addMessageListener', () => {
  async function setupWithChannel() {
    let capturedHandler;
    const ch = makeChannelObj({
      id: 'cX',
      members: ['inbox-self', 'inbox-bob'],
      onSubscribe: (handler) => {
        capturedHandler = handler;
      },
    });
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod({ existingChannels: [ch] });
    applyOverrides({ xmtp, channelMod });

    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m' });
    // Two ticks for the background subscribeAllExistingChannels.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    return { capturedHandler: () => capturedHandler };
  }

  test('every registered listener fires for received messages', async () => {
    const { capturedHandler } = await setupWithChannel();

    const a = [];
    const b = [];
    runtime.addMessageListener((arg) => a.push(arg));
    runtime.addMessageListener((arg) => b.push(arg));

    await capturedHandler()({ id: 'm1', from: 'inbox-bob', content: '{}', parsed: {} });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual({
      channelId: 'cX',
      message: { id: 'm1', from: 'inbox-bob', content: '{}', parsed: {} },
    });
  });

  test('unsubscribe stops further deliveries to that listener', async () => {
    const { capturedHandler } = await setupWithChannel();

    const seen = [];
    const unsubscribe = runtime.addMessageListener((arg) => seen.push(arg));

    await capturedHandler()({ id: 'm1', from: 'inbox-bob', content: '{}', parsed: {} });
    unsubscribe();
    await capturedHandler()({ id: 'm2', from: 'inbox-bob', content: '{}', parsed: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0].message.id).toBe('m1');
  });

  test('a throwing listener does not break sibling listeners', async () => {
    const { capturedHandler } = await setupWithChannel();

    const good = [];
    runtime.addMessageListener(() => {
      throw new Error('boom');
    });
    runtime.addMessageListener((arg) => good.push(arg));

    await capturedHandler()({ id: 'm1', from: 'inbox-bob', content: '{}', parsed: {} });

    expect(good).toHaveLength(1);
  });

  test('rejects non-function listeners', () => {
    expect(() => runtime.addMessageListener(null)).toThrow(TypeError);
    expect(() => runtime.addMessageListener('not a fn')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// getLobbyChannelId — cache reader with identity guards
// ---------------------------------------------------------------------------

describe('getLobbyChannelId', () => {
  test('returns null before start', () => {
    expect(runtime.getLobbyChannelId()).toBeNull();
  });

  test('returns the cached groupId when env + inboxId match', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod();
    const lobby = makeMockLobbyClient(undefined, {
      readLobbyCacheImpl: () => ({
        groupId: 'lobby-id-1',
        env: 'dev',
        inboxId: 'inbox-0xAlice',
      }),
    });
    applyOverrides({ xmtp, channelMod, lobby });

    await runtime.start({ privateKey: '0xa', address: '0xAlice', dataDir: '/tmp/m', env: 'dev' });

    expect(runtime.getLobbyChannelId()).toBe('lobby-id-1');
  });

  test('returns null when env mismatches (e.g. dev → production wallet swap)', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod();
    const lobby = makeMockLobbyClient(undefined, {
      readLobbyCacheImpl: () => ({
        groupId: 'lobby-id-1',
        env: 'production',
        inboxId: 'inbox-0xAlice',
      }),
    });
    applyOverrides({ xmtp, channelMod, lobby });

    await runtime.start({ privateKey: '0xa', address: '0xAlice', dataDir: '/tmp/m', env: 'dev' });

    expect(runtime.getLobbyChannelId()).toBeNull();
  });

  test('returns null when inboxId mismatches (e.g. wallet swap)', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod();
    const lobby = makeMockLobbyClient(undefined, {
      readLobbyCacheImpl: () => ({
        groupId: 'lobby-id-1',
        env: 'dev',
        inboxId: 'inbox-0xCarol',
      }),
    });
    applyOverrides({ xmtp, channelMod, lobby });

    await runtime.start({ privateKey: '0xa', address: '0xAlice', dataDir: '/tmp/m', env: 'dev' });

    expect(runtime.getLobbyChannelId()).toBeNull();
  });

  test('returns null when no cache exists yet', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod();
    const lobby = makeMockLobbyClient(undefined, { readLobbyCacheImpl: () => null });
    applyOverrides({ xmtp, channelMod, lobby });

    await runtime.start({ privateKey: '0xa', address: '0xAlice', dataDir: '/tmp/m', env: 'dev' });

    expect(runtime.getLobbyChannelId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lobby auto-join wiring
// ---------------------------------------------------------------------------

describe('lobby auto-join', () => {
  test('start triggers ensureLobbyMembership in background', async () => {
    const xmtp = makeMockXmtpClient({ conversations: { sync: jest.fn(async () => {}) } });
    const channelMod = makeMockChannelMod();
    const lobby = makeMockLobbyClient(async () => null);
    applyOverrides({ xmtp, channelMod, lobby });

    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m', env: 'dev' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(lobby.ensureLobbyMembership).toHaveBeenCalledWith(
      expect.any(Object),
      '/tmp/m',
      'dev'
    );
  });

  test('a fresh join triggers conversations.sync + re-subscribe', async () => {
    const sync = jest.fn(async () => {});
    const client = { conversations: { sync } };
    const ch = makeChannelObj({ id: 'lobby-id', name: 'Freedom Lobby', members: ['inbox-self'] });
    const xmtp = makeMockXmtpClient(client);
    const channelMod = makeMockChannelMod({ existingChannels: [ch] });
    const lobby = makeMockLobbyClient(async () => ({ groupId: 'lobby-id', fromCache: false }));
    applyOverrides({ xmtp, channelMod, lobby });

    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m', env: 'dev' });
    // Two ticks: one for the initial subscribeAll, one for the lobby
    // background task to settle and re-run subscribeAll.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sync).toHaveBeenCalled();
    // listChannels called twice: once by the initial subscribeAll, once
    // after the lobby join handshake.
    expect(channelMod.listChannels.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('a cached membership skips the post-join sync', async () => {
    const sync = jest.fn(async () => {});
    const client = { conversations: { sync } };
    const xmtp = makeMockXmtpClient(client);
    const channelMod = makeMockChannelMod();
    const lobby = makeMockLobbyClient(async () => ({ groupId: 'lobby-id', fromCache: true }));
    applyOverrides({ xmtp, channelMod, lobby });

    await runtime.start({ privateKey: '0xa', address: '0xA', dataDir: '/tmp/m', env: 'dev' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sync).not.toHaveBeenCalled();
  });

  test('lobby errors do not break startup', async () => {
    const xmtp = makeMockXmtpClient();
    const channelMod = makeMockChannelMod();
    const lobby = makeMockLobbyClient(async () => {
      throw new Error('admin offline');
    });
    applyOverrides({ xmtp, channelMod, lobby });

    const status = await runtime.start({
      privateKey: '0xa',
      address: '0xA',
      dataDir: '/tmp/m',
      env: 'dev',
    });
    await new Promise((r) => setImmediate(r));

    expect(status.started).toBe(true);
    expect(status.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getMessagingDataDir
// ---------------------------------------------------------------------------

describe('getMessagingDataDir', () => {
  test('uses repo path in dev', () => {
    const dir = runtime.getMessagingDataDir({ isPackaged: false });
    expect(dir).toMatch(/messaging-data$/);
    expect(dir).not.toMatch(/userData/);
  });

  test('uses userData path when packaged', () => {
    const dir = runtime.getMessagingDataDir({
      isPackaged: true,
      getPath: (key) => (key === 'userData' ? '/var/userData' : '/'),
    });
    expect(dir).toBe('/var/userData/messaging-data');
  });
});
