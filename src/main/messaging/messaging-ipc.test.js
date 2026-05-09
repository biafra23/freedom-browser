jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// jest.mock factories may only reference variables prefixed with `mock`.
const mockHandlers = new Map();
const mockAllWindows = [];

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn((channel, handler) => {
      mockHandlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    getAllWindows: jest.fn(() => mockAllWindows),
  },
}));

jest.mock('./messaging-runtime', () => {
  const addMessageListener = jest.fn(() => () => {});
  return {
    addMessageListener,
    getStatus: jest.fn(() => ({ started: true, address: '0xA', inboxId: 'inbox-self' })),
    listChannels: jest.fn(async () => [{ id: 'c1', name: 'X', memberCount: 1, memberInboxIds: [] }]),
    createChannel: jest.fn(async (args) => ({
      id: 'g-new',
      name: args.name || null,
      memberCount: 2,
      memberInboxIds: ['inbox-self', `inbox-${args.peerAddresses[0]}`],
    })),
    getChannelMessages: jest.fn(async () => [
      {
        id: 'm1',
        from: 'inbox-bob',
        sentAt: new Date('2026-01-01T00:00:00Z'),
        content: '{"a":1}',
        parsed: { a: 1 },
        parseError: null,
        isOwn: false,
      },
    ]),
    publish: jest.fn(async () => 'msg-id-1'),
  };
});

const runtime = require('./messaging-runtime');
const messagingIpc = require('./messaging-ipc');
const { registerMessagingIpc, _internals } = messagingIpc;
const IPC = require('../../shared/ipc-channels');

function fakeWindow() {
  const sends = [];
  return {
    isDestroyed: () => false,
    webContents: {
      send: jest.fn((channel, payload) => sends.push({ channel, payload })),
    },
    _sends: sends,
  };
}

beforeEach(() => {
  mockHandlers.clear();
  mockAllWindows.length = 0;
  runtime.addMessageListener.mockReset();
  runtime.addMessageListener.mockImplementation(() => () => {});
  messagingIpc._resetForTesting();
});

// ---------------------------------------------------------------------------
// serializeMessage
// ---------------------------------------------------------------------------

describe('serializeMessage', () => {
  test('converts Date sentAt to ISO string and stringifies parseError', () => {
    const out = _internals.serializeMessage({
      id: 'm1',
      from: 'i',
      sentAt: new Date('2026-01-02T03:04:05Z'),
      content: 'hi',
      parsed: null,
      parseError: new Error('bad json'),
      isOwn: false,
    });
    expect(out.sentAt).toBe('2026-01-02T03:04:05.000Z');
    expect(out.parseError).toBe('bad json');
    expect(out.parsed).toBeNull();
    expect(out.isOwn).toBe(false);
  });

  test('returns null on null input', () => {
    expect(_internals.serializeMessage(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerMessagingIpc — handlers wired correctly
// ---------------------------------------------------------------------------

describe('registerMessagingIpc', () => {
  test('registers the expected handler channels', () => {
    registerMessagingIpc();
    expect(mockHandlers.has(IPC.MESSAGING_GET_STATUS)).toBe(true);
    expect(mockHandlers.has(IPC.MESSAGING_START)).toBe(true);
    expect(mockHandlers.has(IPC.MESSAGING_LIST_CHANNELS)).toBe(true);
    expect(mockHandlers.has(IPC.MESSAGING_CREATE_CHANNEL)).toBe(true);
    expect(mockHandlers.has(IPC.MESSAGING_GET_MESSAGES)).toBe(true);
    expect(mockHandlers.has(IPC.MESSAGING_PUBLISH)).toBe(true);
  });

  test('get-status returns wrapped status', async () => {
    registerMessagingIpc();
    const res = await mockHandlers.get(IPC.MESSAGING_GET_STATUS)(null);
    expect(res).toEqual({
      ok: true,
      data: { started: true, address: '0xA', inboxId: 'inbox-self' },
    });
  });

  test('list-channels returns wrapped data', async () => {
    registerMessagingIpc();
    const res = await mockHandlers.get(IPC.MESSAGING_LIST_CHANNELS)(null);
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data[0].id).toBe('c1');
  });

  test('create-channel forwards args and returns wrapped data', async () => {
    registerMessagingIpc();
    const res = await mockHandlers.get(IPC.MESSAGING_CREATE_CHANNEL)(null, {
      peerAddresses: ['0xBob'],
      name: 'Bob',
    });
    expect(runtime.createChannel).toHaveBeenCalledWith({
      peerAddresses: ['0xBob'],
      name: 'Bob',
    });
    expect(res.data.id).toBe('g-new');
  });

  test('get-messages serializes Date and forwards limit', async () => {
    registerMessagingIpc();
    const res = await mockHandlers.get(IPC.MESSAGING_GET_MESSAGES)(null, {
      channelId: 'c1',
      limit: 50,
    });
    expect(runtime.getChannelMessages).toHaveBeenCalledWith('c1', { limit: 50 });
    expect(res.ok).toBe(true);
    expect(typeof res.data[0].sentAt).toBe('string');
  });

  test('publish forwards args and returns the message id', async () => {
    registerMessagingIpc();
    const res = await mockHandlers.get(IPC.MESSAGING_PUBLISH)(null, {
      channelId: 'c1',
      payload: { hello: 'world' },
    });
    expect(runtime.publish).toHaveBeenCalledWith('c1', { hello: 'world' });
    expect(res).toEqual({ ok: true, data: 'msg-id-1' });
  });

  test('handler errors are returned as { ok:false, error }', async () => {
    registerMessagingIpc();
    runtime.publish.mockRejectedValueOnce(new Error('boom'));
    const res = await mockHandlers.get(IPC.MESSAGING_PUBLISH)(null, {
      channelId: 'c1',
      payload: {},
    });
    expect(res).toEqual({ ok: false, error: 'boom' });
  });
});

// ---------------------------------------------------------------------------
// addMessageListener registration — broadcasts to all windows
// ---------------------------------------------------------------------------

describe('renderer fan-out listener', () => {
  test('forwards messages to every BrowserWindow', () => {
    const w1 = fakeWindow();
    const w2 = fakeWindow();
    mockAllWindows.push(w1, w2);

    registerMessagingIpc();
    expect(runtime.addMessageListener).toHaveBeenCalledTimes(1);
    const listener = runtime.addMessageListener.mock.calls[0][0];

    listener({
      channelId: 'cZ',
      message: {
        id: 'm5',
        from: 'inbox-bob',
        sentAt: new Date('2026-01-01T00:00:00Z'),
        content: '{"k":"v"}',
        parsed: { k: 'v' },
        parseError: null,
        isOwn: false,
      },
    });

    expect(w1._sends).toHaveLength(1);
    expect(w1._sends[0]).toMatchObject({
      channel: IPC.MESSAGING_MESSAGE,
      payload: {
        channelId: 'cZ',
        message: {
          id: 'm5',
          from: 'inbox-bob',
          sentAt: '2026-01-01T00:00:00.000Z',
          parsed: { k: 'v' },
        },
      },
    });
    expect(w2._sends).toHaveLength(1);
  });

  test('skips destroyed windows', () => {
    const live = fakeWindow();
    const dead = fakeWindow();
    dead.isDestroyed = () => true;
    mockAllWindows.push(live, dead);

    registerMessagingIpc();
    const listener = runtime.addMessageListener.mock.calls[0][0];
    listener({ channelId: 'c', message: { id: 'm', from: 'x', sentAt: new Date() } });

    expect(live._sends).toHaveLength(1);
    expect(dead._sends).toHaveLength(0);
  });
});
